const fs = require('fs');

// Load the full build.
const _ = require('lodash');

const util = require('util');
const Room = require('./room');
const PlayersReadyNotReady = require('./playersReadyNotReady');

const usernamesIndexes = require('../myFunctions/usernamesIndexes');


const User = require('../models/user');
const GameRecord = require('../models/gameRecord');

const commonPhasesIndex = require('./indexCommonPhases');

// Get all the gamemodes and their roles/cards/phases.
const gameModeNames = [];
fs.readdirSync('./gameplay/').filter((file) => {
    if (fs.statSync(`${'./gameplay' + '/'}${file}`).isDirectory() === true && file !== 'commonPhases') {
        gameModeNames.push(file);
    }
});
// console.log(gameModeNames);
const gameModeObj = {};
for (let i = 0; i < gameModeNames.length; i++) {
    gameModeObj[gameModeNames[i]] = {};

    gameModeObj[gameModeNames[i]].Roles = require(`./${gameModeNames[i]}/indexRoles`);
    gameModeObj[gameModeNames[i]].Phases = require(`./${gameModeNames[i]}/indexPhases`);
    gameModeObj[gameModeNames[i]].Cards = require(`./${gameModeNames[i]}/indexCards`);
}


/**
 *
 * @param {String} host_ Host username
 * @param {Number} roomId_ Room ID
 * @param {IO} io_ IO chat for sockets
 * @param {Number} maxNumPlayers_ Maximum number of players allowed to sit down
 * @param {String} newRoomPassword_ Password to join the room
 * @param {String} gameMode_ Gamemode - avalon/hunter/etc.
 */
function Game(host_, roomId_, io_, maxNumPlayers_, newRoomPassword_, gameMode_, callback_) {
    this.callback = callback_;
    //* *******************************
    // CONSTANTS
    //* *******************************
    this.minPlayers = 5;
    this.alliances = [
        'Resistance',
        'Resistance',
        'Resistance',
        'Spy',
        'Spy',
        'Resistance',
        'Spy',
        'Resistance',
        'Resistance',
        'Spy',
    ];

    this.numPlayersOnMission = [
        ['2', '3', '2', '3', '3'],
        ['2', '3', '4', '3', '4'],
        ['2', '3', '3', '4*', '4'],
        ['3', '4', '4', '5*', '5'],
        ['3', '4', '4', '5*', '5'],
        ['3', '4', '4', '5*', '5'],
    ];

    // Get the Room properties
    Room.call(this, host_, roomId_, io_, maxNumPlayers_, newRoomPassword_, gameMode_);
    PlayersReadyNotReady.call(this, this.minPlayers);

    const thisRoom = this;

    /*
		Handle joining:
			- If game hasn't started, join like usual
			- If game has started, check if they are a player
				- If they are player, give them data
				- If they are not a player, give them spec data
	*/

    /*
		Phases go like this:
			Note: Cards run should be run every time phase changes

			Always run between phases:
				- Card
				- Role specials (e.g. assassination)

			Start from phase 1:
			1) Player picking.
			2) Receive interactions for team votes.
				- If approved, go to phase 3.
				- If rejected, go to phase 1.
			3) Receive interactions for mission votes.
				- If game finished, go to phase 4.
				- If game not finished, go to phase 1.
			4) Game finished


			Table:
				Phase	|	String
				1			"pickingTeam"
				2			"votingTeam"
				3			"votingMission"
				4			"finished"

			Misc Phases:
				Phase	|	String
							"lady"
							"assassination"

	*/


    /*
		Receive interactions depending on current state
	*/

    // Game variables
    this.gameStarted = false;
    this.finished = false;

    this.phase = 'pickingTeam';
    this.phaseBeforePause = '';

    this.playersInGame = [];
    this.playerUsernamesInGame = [];

    this.resistanceUsernames = [];
    this.spyUsernames = [];

    this.roleKeysInPlay = [];
    this.cardKeysInPlay = [];

    this.teamLeader = 0;
    this.hammer = 0;
    this.missionNum = 0;
    this.pickNum = 0;
    this.missionHistory = [];
    this.numFailsHistory = [];
    this.proposedTeam = [];
    this.lastProposedTeam = [];
    this.votes = [];
    // Only show all the votes when they've all come in, not one at a time
    this.publicVotes = [];
    this.missionVotes = [];

    this.voteHistory = {};

    // Game misc variables
    this.winner = '';
    this.options = undefined;

    // Room variables
    this.destroyRoom = false;

    // Room misc variables
    this.chatHistory = []; // Here because chatHistory records after game starts
}

// Game object inherits all the functions and stuff from Room
Game.prototype = Object.create(Room.prototype);
Object.assign(Game.prototype, PlayersReadyNotReady.prototype);


// RECOVER GAME!
Game.prototype.recoverGame = function (storedData) {
    // Set a few variables back to new state
    this.allSockets = [];
    this.socketsOfPlayers = [];
    this.frozen = true;
    this.timeFrozenLoaded = new Date();
    this.someCutoffPlayersJoined = 'no';

    // Reload all objects so that their functions are also generated
    // Functions are not stored with JSONified during storage
    this.commonPhases = (new commonPhasesIndex()).getPhases(this);

    // New Room Object - Just add in the new functions we need
    const roomFunctions = {};

    Game.prototype = Object.assign(Game.prototype, roomFunctions);
    Object.assign(Game.prototype, PlayersReadyNotReady.prototype);

    this.specialRoles = (new gameModeObj[this.gameMode].Roles()).getRoles(this);
    this.specialPhases = (new gameModeObj[this.gameMode].Phases()).getPhases(this);
    this.specialCards = (new gameModeObj[this.gameMode].Cards()).getCards(this);


    // Roles
    // Remove the circular dependency
    for (var key in storedData.specialRoles) {
        if (storedData.specialRoles.hasOwnProperty(key)) {
            delete (storedData.specialRoles[key].thisRoom);
        }
    }
    // Merge in the objects
    _.merge(this.specialRoles, storedData.specialRoles);

    // Cards
    // Remove the circular dependency
    for (var key in storedData.specialCards) {
        if (storedData.specialCards.hasOwnProperty(key)) {
            delete (storedData.specialCards[key].thisRoom);
        }
    }
    // Merge in the objects
    _.merge(this.specialCards, storedData.specialCards);
};

//------------------------------------------------
// METHOD OVERRIDES ------------------------------
//------------------------------------------------
Game.prototype.playerJoinRoom = function (socket, inputPassword) {
    if (this.gameStarted === true) {
        // if the new socket is a player, add them to the sockets of players
        for (let i = 0; i < this.playersInGame.length; i++) {
            if (this.playersInGame[i].username === socket.request.user.username) {
                this.socketsOfPlayers.splice(i, 0, socket);
                this.playersInGame[i].request = socket.request;

                break;
            }
        }

        // Checks for frozen games. Don't delete a frozen game until at least 5 players have joined
        if (this.someCutoffPlayersJoined === 'no' && this.allSockets.length >= 5) {
            this.frozen = false;
            this.someCutoffPlayersJoined === 'yes';
        }

        const resultOfRoomJoin = Room.prototype.playerJoinRoom.call(this, socket, inputPassword);

        // If the player failed the join, remove their socket.
        if (resultOfRoomJoin === false) {
            const index = this.socketsOfPlayers.indexOf(socket);
            if (index !== -1) {
                this.socketsOfPlayers.splice(index, 1);
            }
        }

        return resultOfRoomJoin;
    }

    return Room.prototype.playerJoinRoom.call(this, socket, inputPassword);
};

Game.prototype.playerSitDown = function (socket) {
    // If the game has started
    if (this.gameStarted === true) {
        socket.emit('danger-alert', 'Game has already started.');
        return;
    }
    // If the ready/not ready phase is ongoing
    if (this.canJoin === false) {
        socket.emit('danger-alert', 'The game is currently trying to start (ready/not ready phase). You can join if someone is not ready, or after 10 seconds has elapsed.');
        return;
    }

    Room.prototype.playerSitDown.call(this, socket);
};

Game.prototype.playerStandUp = function (socket) {
    // If the ready/not ready phase is ongoing
    if (this.canJoin === false) {
        // socket.emit("danger-alert", "The game is currently trying to start (ready/not ready phase). You cannot stand up now.");
        return;
    }
    // If the game has started
    if (this.gameStarted === true) {
        socket.emit('danger-alert', "The game has started... You shouldn't be able to see that stand up button!");
        return;
    }

    Room.prototype.playerStandUp.call(this, socket);
};

Game.prototype.playerLeaveRoom = function (socket) {
    if (this.gameStarted === true) {
        // if they exist in socketsOfPlayers, then remove them
        var index = this.socketsOfPlayers.indexOf(socket);
        if (index !== -1) {
            // console.log("Removing index " + index);
            this.socketsOfPlayers.splice(index, 1);
        }
        // Remove from all sockets as well
        index = this.allSockets.indexOf(socket);
        if (index !== -1) {
            // console.log("Removing index " + index);
            this.allSockets.splice(index, 1);
        }

        this.distributeGameData();
    } else {
        // If we are in player ready not ready phase, then make them not ready and then perform
        // the usual leave room procedures.
        var index = this.socketsOfPlayers.indexOf(socket);
        if (index !== -1 && this.playersYetToReady !== undefined && this.playersYetToReady.length !== undefined && this.playersYetToReady.length !== 0) {
            this.playerNotReady();
            const { username } = socket.request.user;
            this.sendText(this.allSockets, `${username} is not ready.`, 'server-text');
        }
    }

    // If one person left in the room, the host would change
    // after the game started. So this will fix it

    let origHost;
    if (this.gameStarted === true) {
        origHost = this.host;
    }

    Room.prototype.playerLeaveRoom.call(this, socket);

    if (this.gameStarted === true) {
        this.host = origHost;
    }
};


// start game
Game.prototype.startGame = function (options) {
    if (this.socketsOfPlayers.length < 5 || this.socketsOfPlayers.length > 10 || this.gamePlayerLeftDuringReady === true) {
        this.canJoin = true;
        this.gamePlayerLeftDuringReady = false;
        return false;
    }
    this.startGameTime = new Date();


    // make game started after the checks for game already started
    this.gameStarted = true;
    this.merlinguesses = {};

    let rolesAssignment = generateAssignmentOrders(this.socketsOfPlayers.length);

    let shuffledPlayerAssignments = [];
    // shuffle the players around. Make sure to redistribute this room player data in sockets.
    for (var i = 0; i < this.socketsOfPlayers.length; i++) {
        shuffledPlayerAssignments[i] = i;
    }
    shuffledPlayerAssignments = shuffle(shuffledPlayerAssignments);

    const tempSockets = [];
    // create temp sockets
    for (var i = 0; i < this.socketsOfPlayers.length; i++) {
        tempSockets[i] = this.socketsOfPlayers[i];
    }

    // assign the shuffled sockets
    for (var i = 0; i < this.socketsOfPlayers.length; i++) {
        this.socketsOfPlayers[i] = tempSockets[shuffledPlayerAssignments[i]];
    }

    // Now we initialise roles
    for (var i = 0; i < this.socketsOfPlayers.length; i++) {
        this.playersInGame[i] = {};
        // assign them the sockets but with shuffled.
        this.playersInGame[i].username = this.socketsOfPlayers[i].request.user.username;
        this.playersInGame[i].userId = this.socketsOfPlayers[i].request.user._id;

        this.playersInGame[i].request = this.socketsOfPlayers[i].request;

        // set the role to be from the roles array with index of the value
        // of the rolesAssignment which has been shuffled
        this.playersInGame[i].alliance = this.alliances[rolesAssignment[i]];

        this.playerUsernamesInGame.push(this.socketsOfPlayers[i].request.user.username);
    }


    // for(var key in this.specialRoles){
    // 	if(this.specialRoles.hasOwnProperty(key)){
    // 		console.log("Key: " + key);
    // 	}
    // }

    // Give roles to the players according to their alliances
    // Get roles:
    this.resRoles = [];
    this.spyRoles = [];

    for (var i = 0; i < options.length; i++) {
        const op = options[i].toLowerCase();
        // console.log(op);
        // If a role file exists for this
        if (this.specialRoles.hasOwnProperty(op)) {
            // If it is a res:
            if (this.specialRoles[op].alliance === 'Resistance') {
                this.resRoles.push(this.specialRoles[op].role);
            } else if (this.specialRoles[op].alliance === 'Spy') {
                this.spyRoles.push(this.specialRoles[op].role);
            } else {
                console.log('THIS SHOULD NOT HAPPEN! Invalid role file. Look in game.js file.');
            }
            this.roleKeysInPlay.push(op);
        }

        // If a card file exists for this
        else if (this.specialCards.hasOwnProperty(op)) {
            this.cardKeysInPlay.push(op);
        } else {
            console.log(`Warning: Client requested a role that doesn't exist -> ${op}`);
        }
    }

    const resPlayers = [];
    const spyPlayers = [];

    for (var i = 0; i < this.playersInGame.length; i++) {
        if (this.playersInGame[i].alliance === 'Resistance') {
            resPlayers.push(i);
            this.resistanceUsernames.push(this.playersInGame[i].username);
        } else if (this.playersInGame[i].alliance === 'Spy') {
            spyPlayers.push(i);
            this.spyUsernames.push(this.playersInGame[i].username);
        }
    }

    // Assign the res roles randomly
    rolesAssignment = generateAssignmentOrders(resPlayers.length);
    for (var i = 0; i < rolesAssignment.length; i++) {
        this.playersInGame[resPlayers[i]].role = this.resRoles[rolesAssignment[i]];
        // console.log("res role: " + resRoles[rolesAssignment[i]]);
    }

    // Assign the spy roles randomly
    rolesAssignment = generateAssignmentOrders(spyPlayers.length);
    for (var i = 0; i < rolesAssignment.length; i++) {
        this.playersInGame[spyPlayers[i]].role = this.spyRoles[rolesAssignment[i]];
        // console.log("spy role: " + spyRoles[rolesAssignment[i]]);
    }


    // for those players with no role, set their role to their alliance (i.e. for Resistance VT and Spy VS)
    for (var i = 0; i < this.playersInGame.length; i++) {
        // console.log(this.playersInGame[i].role);
        if (this.playersInGame[i].role === undefined) {
            this.playersInGame[i].role = this.playersInGame[i].alliance;
            // console.log("Overwrite role as alliance for player: " + this.playersInGame[i].username);
        }
    }

    // Prepare the data for each person to see for the rest of the game.
    // The following data do not change as the game goes on.
    for (var i = 0; i < this.playersInGame.length; i++) {
        // Lowercase the role to give the file name
        const roleLower = this.playersInGame[i].role.toLowerCase();
        this.playersInGame[i].see = this.specialRoles[roleLower].see();
    }

    // set game start parameters
    // get a random starting team leader
    this.teamLeader = getRandomInt(0, this.playersInGame.length);
    this.hammer = ((this.teamLeader - 5 + 1 + this.playersInGame.length) % this.playersInGame.length);

    this.missionNum = 1;
    this.pickNum = 1;
    this.missionHistory = [];

    let str = 'Game started with: ';
    for (var i = 0; i < this.roleKeysInPlay.length; i++) {
        str += `${this.specialRoles[this.roleKeysInPlay[i]].role}, `;
    }
    for (var i = 0; i < this.cardKeysInPlay.length; i++) {
        str += `${this.specialCards[this.cardKeysInPlay[i]].card}, `;
    }

    // remove the last , and replace with .
    str = str.slice(0, str.length - 2);
    str += '.';
    this.sendText(this.allSockets, str, 'gameplay-text');


    // seed the starting data into the VH
    for (var i = 0; i < this.playersInGame.length; i++) {
        this.voteHistory[this.playersInGame[i].request.user.username] = [];
    }

    // Initialise all the Cards
    for (var i = 0; i < this.cardKeysInPlay.length; i++) {
        this.specialCards[this.cardKeysInPlay[i]].initialise();
    }

    this.distributeGameData();

    this.botIndexes = [];
    for (var i = 0; i < this.socketsOfPlayers.length; i++) {
        if (this.socketsOfPlayers[i].isBotSocket === true) {
            this.botIndexes.push(i);
        }
    }

    const thisGame = this;
    const pendingBots = [];
    this.socketsOfPlayers.filter((socket) => socket.isBotSocket).forEach((botSocket) => {
        pendingBots.push(botSocket);
        botSocket.handleGameStart(thisGame, (success, reason) => {
            if (success) {
                pendingBots.splice(pendingBots.indexOf(botSocket), 1);
            } else {
                let message = `${botSocket.request.user.username} failed to initialize and has left the game.`;
                if (reason) {
                    message += ` Reason: ${reason}`;
                }
                thisGame.sendText(thisGame.allSockets, message, 'server-text-teal');
                thisGame.playerLeaveRoom(botSocket);
            }
        });
    });

    this.checkBotMoves(pendingBots);

    return true;
};

Game.prototype.checkBotMoves = function (pendingBots) {
    if (this.botIndexes.length === 0) {
        return;
    }

    const timeEachLoop = 1000;

    const thisRoom = this;

    // Players whose moves we're waiting for
    this.interval = setInterval(() => {
        if (thisRoom.finished === true) {
            clearInterval(thisRoom.interval);
            thisRoom.interval = undefined;
        }

        thisRoom.botSockets.forEach((botSocket) => {
            const botIndex = thisRoom.socketsOfPlayers.indexOf(botSocket);
            if (botIndex === -1) {
                return;
            }

            const buttons = thisRoom.getClientButtonSettings(botIndex);
            const numOfTargets = thisRoom.getClientNumOfTargets(botIndex);
            const prohibitedIndexesToPick = thisRoom.getProhibitedIndexesToPick(botIndex) || [];

            const availableButtons = [];
            if (buttons.green.hidden !== true) {
                availableButtons.push('yes');
            }
            const seatIndex = usernamesIndexes.getIndexFromUsername(thisRoom.playersInGame, botSocket.request.user.username);
            const onMissionAndResistance = (thisRoom.phase == 'votingMission' && thisRoom.playersInGame[seatIndex].alliance === 'Resistance');
            // Add a special case so resistance bots can't fail missions.
            if (buttons.red.hidden !== true && onMissionAndResistance === false) {
                availableButtons.push('no');
            }

            // Skip bots we don't need moves from.
            if (availableButtons.length == 0) {
                return;
            }

            // Skip bots whose moves are pending. (We're waiting for them to respond).
            if (pendingBots.indexOf(botSocket) !== -1) {
                return;
            }

            pendingBots.push(botSocket);

            var availablePlayers = thisRoom.playersInGame
                .filter((player, playerIndex) => prohibitedIndexesToPick.indexOf(playerIndex) === -1).map((player) => player.request.user.username);

            // If there are 0 number of targets, there are no available players.
            if (numOfTargets === null) {
                var availablePlayers = [];
            }

            botSocket.handleRequestAction(thisRoom, availableButtons, availablePlayers, numOfTargets, (move, reason) => {
                // Check for move failure.
                if (move === false) {
                    var message = `${botSocket.request.user.username} failed to make a move and has left the game.`;
                    if (reason) {
                        message += ` Reason: ${reason}`;
                    }
                    thisRoom.sendText(thisRoom.allSockets, message, 'server-text-teal');
                    thisRoom.playerLeaveRoom(botSocket);
                    return;
                }

                // Check for move validity.
                const pressedValidButton = (availableButtons.indexOf(move.buttonPressed) !== -1);
                const selectedValidPlayers = (
                    numOfTargets === 0 || numOfTargets === null || (
                        move.selectedPlayers
                        && numOfTargets === move.selectedPlayers.length
                        && move.selectedPlayers.every((player) => availablePlayers.indexOf(player) !== -1)
                    )
                );

                if (!pressedValidButton || !selectedValidPlayers) {
                    var message = `${botSocket.request.user.username} made an illegal move and has left the game. Move: ${JSON.stringify(move)}`;
                    thisRoom.sendText(thisRoom.allSockets, message, 'server-text-teal');
                    thisRoom.playerLeaveRoom(botSocket);
                    return;
                }

                pendingBots.splice(pendingBots.indexOf(botSocket), 1);

                //! Note: the inputs into gameMove() here are legacy inputs. New bots should conform to the new inputs expected by gameMove.
                // Make the move
                if (numOfTargets == 0 || numOfTargets == null) {
                    thisRoom.gameMove(botSocket, [move.buttonPressed, []]);
                } else {
                    thisRoom.gameMove(botSocket, ['yes', move.selectedPlayers]);
                }
            });
        });
    }, timeEachLoop);
};


//* *************************************************
// Get phase functions start*************************
//* *************************************************

// var commonPhases = ["pickingTeam", "votingTeam", "votingMission", "finished"];
// TODO In the future gameMove should receive both buttonPressed and selectedPlayers
Game.prototype.gameMove = function (socket, data) {
    if (data.length !== 2) {
        return;
    }

    buttonPressed = data[0];
    selectedPlayers = data[1];

    // console.log(buttonPressed, selectedPlayers);

    if (selectedPlayers === undefined || selectedPlayers === null) {
        selectedPlayers = [];
    }


    // Common phases
    if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].gameMove) {
        this.commonPhases[this.phase].gameMove(socket, buttonPressed, selectedPlayers);
    }

    // Special phases
    else if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].gameMove) {
        this.specialPhases[this.phase].gameMove(socket, buttonPressed, selectedPlayers);
    }

    // THIS SHOULDN'T HAPPEN!! We always require a gameMove function to change phases
    else {
        this.sendText(this.allSockets, 'ERROR LET ADMIN KNOW IF YOU SEE THIS code 1', 'gameplay-text');
    }

    // RUN SPECIAL ROLE AND CARD CHECKS
    this.checkRoleCardSpecialMoves(socket, buttonPressed, selectedPlayers);

    this.distributeGameData();
};

Game.prototype.toShowGuns = function () {
    // Common phases
    if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].showGuns) {
        return this.commonPhases[this.phase].showGuns;
    }

    // Special phases
    if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].showGuns) {
        this.specialPhases[this.phase].showGuns;
    } else {
        return false;
    }
};

Game.prototype.getClientNumOfTargets = function (indexOfPlayer) {
    // Common phases
    if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].numOfTargets) {
        return this.commonPhases[this.phase].numOfTargets(indexOfPlayer);
    }

    // Special phases
    if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].numOfTargets) {
        return this.specialPhases[this.phase].numOfTargets(indexOfPlayer);
    }


    return 0;
};

Game.prototype.getClientButtonSettings = function (indexOfPlayer) {
    if (indexOfPlayer !== undefined) {
        // Common phases
        if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].buttonSettings) {
            return this.commonPhases[this.phase].buttonSettings(indexOfPlayer);
        }

        // Special phases
        if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].buttonSettings) {
            return this.specialPhases[this.phase].buttonSettings(indexOfPlayer);
        }


        // Spectator data
        var obj = {
            green: {},
            red: {},
        };

        obj.green.hidden = true;
        obj.green.disabled = true;
        obj.green.setText = '';

        obj.red.hidden = true;
        obj.red.disabled = true;
        obj.red.setText = '';

        return obj;
    }
    // User is a spectator

    var obj = {
        green: {},
        red: {},
    };

    obj.green.hidden = true;
    obj.green.disabled = true;
    obj.green.setText = '';

    obj.red.hidden = true;
    obj.red.disabled = true;
    obj.red.setText = '';

    return obj;
};

Game.prototype.getStatusMessage = function (indexOfPlayer) {
    // Common phases
    if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].getStatusMessage) {
        return this.commonPhases[this.phase].getStatusMessage(indexOfPlayer);
    }

    // Special phases
    if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].getStatusMessage) {
        return this.specialPhases[this.phase].getStatusMessage(indexOfPlayer);
    }


    return 'There is no status message for the current phase... Let admin know if you see this code 5.';
};

Game.prototype.getProhibitedIndexesToPick = function (indexOfPlayer) {
    // Common phases
    if (this.commonPhases.hasOwnProperty(this.phase) === true && this.commonPhases[this.phase].getProhibitedIndexesToPick) {
        return this.commonPhases[this.phase].getProhibitedIndexesToPick(indexOfPlayer);
    }

    // Special phases
    if (this.specialPhases.hasOwnProperty(this.phase) === true && this.specialPhases[this.phase].getProhibitedIndexesToPick) {
        return this.specialPhases[this.phase].getProhibitedIndexesToPick(indexOfPlayer);
    }


    return undefined;
};

//* *************************************************
// Get phase functions end***************************
//* *************************************************


Game.prototype.incrementTeamLeader = function () {
    // move to next team Leader, and reset it back to the start if
    // we go into negative numbers
    this.teamLeader--;
    if (this.teamLeader < 0) {
        this.teamLeader = this.playersInGame.length - 1;
    }
    this.pickNum++;
};

Game.prototype.getRoomPlayers = function () {
    if (this.gameStarted === true) {
        const roomPlayers = [];

        for (let i = 0; i < this.playersInGame.length; i++) {
            var isClaiming;
            // If the player's username exists on the list of claiming:
            if (this.claimingPlayers.indexOf(this.playersInGame[i].request.user.username) !== -1) {
                isClaiming = true;
            } else {
                isClaiming = false;
            }

            roomPlayers[i] = {
                username: this.playersInGame[i].request.user.username,
                avatarImgRes: this.playersInGame[i].request.user.avatarImgRes,
                avatarImgSpy: this.playersInGame[i].request.user.avatarImgSpy,
                avatarHide: this.playersInGame[i].request.user.avatarHide,
                claim: isClaiming,
            };

            // give the host the teamLeader star
            if (roomPlayers[i].username === this.host) {
                roomPlayers[i].teamLeader = true;
            }
        }
        return roomPlayers;
    }

    return Room.prototype.getRoomPlayers.call(this);
};


Game.prototype.distributeGameData = function () {
    // distribute roles to each player
    this.updateRoomPlayers();

    if (this.gameStarted === true) {
        const gameData = this.getGameData();
        for (let i = 0; i < this.playersInGame.length; i++) {
            const index = usernamesIndexes.getIndexFromUsername(this.socketsOfPlayers, this.playersInGame[i].request.user.username);
            // need to go through all sockets, but only send to the socket of players in game
            if (this.socketsOfPlayers[index]) {
                this.socketsOfPlayers[index].emit('game-data', gameData[i]);
                // console.log("Sent to player: " + this.playersInGame[i].request.user.username + " role " + gameData[i].role);
            }
        }

        const gameDataForSpectators = this.getGameDataForSpectators();

        const sockOfSpecs = this.getSocketsOfSpectators();
        sockOfSpecs.forEach((sock) => {
            sock.emit('game-data', gameDataForSpectators);
            // console.log("(for loop) Sent to spectator: " + sock.request.user.username);
        });
    }
};


Game.prototype.getGameData = function () {
    if (this.gameStarted == true) {
        const data = {};
        const playerRoles = this.playersInGame;

        // set up the object first, because we cannot pass an array through
        // socket.io
        for (let i = 0; i < playerRoles.length; i++) {
            // Player specific data
            data[i] = {
                alliance: playerRoles[i].alliance,
                role: playerRoles[i].role,
                see: playerRoles[i].see,
                username: playerRoles[i].username,
                socketId: playerRoles[i].socketId,
            };

            // add on these common variables:
            data[i].buttons = this.getClientButtonSettings(i);

            data[i].statusMessage = this.getStatusMessage(i);

            data[i].missionNum = this.missionNum;
            data[i].missionHistory = this.missionHistory;
            data[i].numFailsHistory = this.numFailsHistory;
            data[i].pickNum = this.pickNum;
            data[i].teamLeader = this.teamLeader;
            data[i].teamLeaderReversed = gameReverseIndex(this.teamLeader, this.playersInGame.length);
            data[i].hammer = this.hammer;

            data[i].playersYetToVote = this.playersYetToVote;
            data[i].phase = this.phase;
            data[i].proposedTeam = this.proposedTeam;

            data[i].numPlayersOnMission = this.numPlayersOnMission[playerRoles.length - this.minPlayers]; // - 5
            data[i].numSelectTargets = this.getClientNumOfTargets(i);

            data[i].votes = this.publicVotes;
            data[i].voteHistory = this.voteHistory;
            data[i].hammer = this.hammer;
            data[i].hammerReversed = gameReverseIndex(this.hammer, this.playersInGame.length);
            data[i].winner = this.winner;

            data[i].playerUsernamesOrdered = getUsernamesOfPlayersInGame(this);
            data[i].playerUsernamesOrderedReversed = gameReverseArray(getUsernamesOfPlayersInGame(this));

            data[i].gameplayMessage = this.gameplayMessage;

            data[i].spectator = false;
            data[i].gamePlayersInRoom = getUsernamesOfPlayersInRoom(this);

            data[i].roomId = this.roomId;
            data[i].toShowGuns = this.toShowGuns();

            data[i].publicData = this.getRoleCardPublicGameData();
            data[i].prohibitedIndexesToPicks = this.getProhibitedIndexesToPick(i);

            data[i].roles = this.playersInGame.map((player) => player.role);
            // This is hacky but it works, for now...
            data[i].cards = this.options.filter((option) => option.indexOf('of the') !== -1);


            // if game is finished, reveal everything including roles
            if (this.phase === 'finished') {
                data[i].see = {};
                data[i].see.spies = getAllSpies(this);
                data[i].see.roles = getRevealedRoles(this);
                data[i].proposedTeam = this.lastProposedTeam;
            } else if (this.phase === 'assassination') {
                data[i].proposedTeam = this.lastProposedTeam;
            }
        }
        return data;
    }

    return "Game hasn't started";
};


Game.prototype.getGameDataForSpectators = function () {
    // return false;
    const playerRoles = this.playersInGame;

    // set up the spectator data object
    const data = {};

    data.see = {};
    data.see.spies = [];
    data.see.merlins = [];

    data.buttons = this.getClientButtonSettings();

    data.statusMessage = this.getStatusMessage(-1);
    data.missionNum = this.missionNum;
    data.missionHistory = this.missionHistory;
    data.numFailsHistory = this.numFailsHistory;
    data.pickNum = this.pickNum;
    data.teamLeader = this.teamLeader;
    data.teamLeaderReversed = gameReverseIndex(this.teamLeader, this.playersInGame.length);
    data.hammer = this.hammer;

    data.playersYetToVote = this.playersYetToVote;
    data.phase = this.phase;
    data.proposedTeam = this.proposedTeam;

    data.numPlayersOnMission = this.numPlayersOnMission[playerRoles.length - this.minPlayers]; // - 5
    data.numSelectTargets = this.getClientNumOfTargets();

    data.votes = this.publicVotes;
    data.voteHistory = this.voteHistory;
    data.hammer = this.hammer;
    data.hammerReversed = gameReverseIndex(this.hammer, this.playersInGame.length);
    data.winner = this.winner;

    data.playerUsernamesOrdered = getUsernamesOfPlayersInGame(this);
    data.playerUsernamesOrderedReversed = gameReverseArray(getUsernamesOfPlayersInGame(this));

    data.gameplayMessage = this.gameplayMessage;

    data.spectator = true;
    data.gamePlayersInRoom = getUsernamesOfPlayersInRoom(this);

    data.roomId = this.roomId;
    data.toShowGuns = this.toShowGuns();

    data.publicData = this.getRoleCardPublicGameData();


    // if game is finished, reveal everything including roles
    if (this.phase === 'finished') {
        data.see = {};
        data.see.spies = getAllSpies(this);
        data.see.roles = getRevealedRoles(this);
        data.proposedTeam = this.lastProposedTeam;
    } else if (this.phase === 'assassination') {
        data.proposedTeam = this.lastProposedTeam;
    }

    return data;
};


// Misc game room functions
Game.prototype.addToChatHistory = function (data) {
    if (this.gameStarted === true) {
        this.chatHistory.push(data);
    }

    if (data.message === '-teamleader') {
        this.sendText(null, `Team leader is: ${this.teamLeader}`, 'server-text');
    }
    if (data.message === '-socketsofplayers') {
        this.sendText(null, `Sockets of players length is: ${this.socketsOfPlayers.length}`, 'server-text');
    }
    if (data.message === '-playersingame') {
        this.sendText(null, `Players in game length is: ${this.playersInGame.length}`, 'server-text');
    }
};

Game.prototype.getStatus = function () {
    if (this.finished === true) {
        return 'Finished';
    }
    if (this.frozen === true) {
        return 'Frozen';
    }
    if (this.phase === "paused") {
        return 'Paused';
    }
    if (this.gameStarted === true) {
        return 'Game in progress';
    }

    return 'Waiting';
};

Game.prototype.finishGame = function (toBeWinner) {
    this.phase = 'finished';

    if (this.checkRoleCardSpecialMoves() === true) {
        return;
    }

    // If after the special card/role check the phase is
    // not finished now, then don't run the rest of the code below
    if (this.phase !== 'finished') {
        return;
    }

    for (var i = 0; i < this.allSockets.length; i++) {
        this.allSockets[i].emit('gameEnded');
    }

    // game clean up
    this.finished = true;
    this.winner = toBeWinner;

    // Post results of Merlin guesses
    if (this.resRoles.indexOf('Merlin') !== -1) {
        const guessesByTarget = reverseMapFromMap(this.merlinguesses);

        const incorrectGuessersText = [];
        const usernameOfMerlin = this.playersInGame.find((player) => player.role === 'Merlin').username;
        for (const target in guessesByTarget) {
            if (guessesByTarget.hasOwnProperty(target)) {
                if (target === usernameOfMerlin) {
                    this.sendText(this.allSockets, `Correct Merlin guessers were: ${guessesByTarget[target].join(', ')}`, 'server-text');
                } else {
                    incorrectGuessersText.push(`${guessesByTarget[target].join(', ')} (->${target})`);
                }
            }
        }
        if (incorrectGuessersText.length > 0) {
            this.sendText(this.allSockets, `Incorrect Merlin guessers were: ${incorrectGuessersText.join('; ')}`, 'server-text');
        }
    }

    // Reset votes
    this.votes = [];
    this.publicVotes = [];

    this.distributeGameData();

    // If there was a bot in the game and this is the online server, do not store into the database.
    // if (process.env.MY_PLATFORM === "online" && this.botIndexes.length !== 0) {
    // 	return;
    // }

    // store data into the database:
    const rolesCombined = [];

    // combine roles
    for (var i = 0; i < (this.resRoles.length + this.spyRoles.length); i++) {
        if (i < this.resRoles.length) {
            rolesCombined[i] = this.resRoles[i];
        } else {
            rolesCombined[i] = this.spyRoles[i - this.resRoles.length];
        }
    }

    const playerRolesVar = {};

    for (var i = 0; i < this.playersInGame.length; i++) {
        playerRolesVar[this.playersInGame[i].username] = {
            alliance: this.playersInGame[i].alliance,
            role: this.playersInGame[i].role,
        };
    }

    let ladyChain;
    let ladyHistoryUsernames;
    if (this.specialCards && this.specialCards['lady of the lake']) {
        ladyChain = this.specialCards['lady of the lake'].ladyChain;
        ladyHistoryUsernames = this.specialCards['lady of the lake'].ladyHistoryUsernames;
    }

    let refChain;
    let refHistoryUsernames;
    if (this.specialCards && this.specialCards['ref of the rain']) {
        refChain = this.specialCards['ref of the rain'].refChain;
        refHistoryUsernames = this.specialCards['ref of the rain'].refHistoryUsernames;
    }

    let sireChain;
    let sireHistoryUsernames;
    if (this.specialCards && this.specialCards['sire of the sea']) {
        sireChain = this.specialCards['sire of the sea'].sireChain;
        sireHistoryUsernames = this.specialCards['sire of the sea'].sireHistoryUsernames;
    }

    // console.log(this.gameMode);
    let botUsernames;
    if (this.botSockets !== undefined) {
        botUsernames = this.botSockets.map((botSocket) => botSocket.request.user.username);
    } else {
        botUsernames = [];
    }

    const objectToStore = {
        timeGameStarted: this.startGameTime,
        timeAssassinationStarted: this.startAssassinationTime,
        timeGameFinished: new Date(),
        winningTeam: this.winner,
        spyTeam: this.spyUsernames,
        resistanceTeam: this.resistanceUsernames,
        numberOfPlayers: this.playersInGame.length,

        gameMode: this.gameMode,
        botUsernames,

        playerUsernamesOrdered: getUsernamesOfPlayersInGame(this),
        playerUsernamesOrderedReversed: gameReverseArray(getUsernamesOfPlayersInGame(this)),

        howTheGameWasWon: this.howWasWon,

        roles: rolesCombined,
        cards: this.cardKeysInPlay,

        missionHistory: this.missionHistory,
        numFailsHistory: this.numFailsHistory,
        voteHistory: this.voteHistory,
        playerRoles: playerRolesVar,

        ladyChain,
        ladyHistoryUsernames,

        refChain,
        refHistoryUsernames,

        sireChain,
        sireHistoryUsernames,

        whoAssassinShot: this.whoAssassinShot,
        whoAssassinShot2: this.whoAssassinShot2,
    };

    GameRecord.create(objectToStore, (err) => {
        if (err) {
            console.log(err);
        } else {
            console.log('Stored game data successfully.');
        }
    });

    // store player data:
    const timeFinished = new Date();
    const timeStarted = new Date(this.startGameTime);

    const gameDuration = new Date(timeFinished - timeStarted);


    const playersInGameVar = this.playersInGame;
    const winnerVar = this.winner;

    const thisGame = this;
    this.socketsOfPlayers.filter((socket) => socket.isBotSocket).forEach((botSocket) => {
        botSocket.handleGameOver(thisGame, 'complete', (shouldLeave) => {
            if (shouldLeave) {
                thisGame.playerLeaveRoom(botSocket);
            }
        });
    });

    if (botUsernames.length === 0) {
        this.playersInGame.forEach((player) => {
            User.findById(player.userId).populate('modAction').populate('notifications').exec((err, foundUser) => {
                if (err) { console.log(err); } else if (foundUser) {
                    foundUser.totalTimePlayed = new Date(foundUser.totalTimePlayed.getTime() + gameDuration.getTime());

                    // update individual player statistics
                    foundUser.totalGamesPlayed += 1;

                    if (winnerVar === player.alliance) {
                        foundUser.totalWins += 1;
                        if (winnerVar === 'Resistance') {
                            foundUser.totalResWins += 1;
                        }
                    } else {
                        // loss
                        foundUser.totalLosses += 1;
                        if (winnerVar === 'Spy') {
                            foundUser.totalResLosses += 1;
                        }
                    }

                    // checks that the var exists
                    if (!foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`]) {
                        foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`] = {
                            wins: 0,
                            losses: 0,
                        };
                    }
                    if (!foundUser.roleStats[`${playersInGameVar.length}p`]) {
                        foundUser.roleStats[`${playersInGameVar.length}p`] = {};
                    }
                    if (!foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()]) {
                        foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()] = {
                            wins: 0,
                            losses: 0,
                        };
                    }


                    if (winnerVar === player.alliance) {
                        // checks
                        if (isNaN(foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].losses)) {
                            foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].wins = 0;
                        }
                        if (isNaN(foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].wins)) {
                            foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].wins = 0;
                        }
                        // console.log("=NaN?");
                        // console.log(isNaN(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()].wins));

                        foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].wins += 1;
                        foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].wins += 1;
                    } else {
                        // checks
                        if (isNaN(foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].losses)) {
                            foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].losses = 0;
                        }
                        if (isNaN(foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].losses)) {
                            foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].losses = 0;
                        }

                        foundUser.winsLossesGameSizeBreakdown[`${playersInGameVar.length}p`].losses += 1;
                        foundUser.roleStats[`${playersInGameVar.length}p`][player.role.toLowerCase()].losses += 1;
                    }
                    // console.log("Rolestat for player");
                    // console.log(foundUser.roleStats[playersInGameVar.length + "p"][player.role.toLowerCase()]);

                    foundUser.markModified('winsLossesGameSizeBreakdown');
                    foundUser.markModified('roleStats');

                    foundUser.save();
                    // console.log("SAVE SAVE");
                }
            });
        });
    }
};

Game.prototype.calcMissionVotes = function (votes) {
    let requiresTwoFails = false;
    if (this.playersInGame.length >= 7 && this.missionNum === 4) {
        requiresTwoFails = true;
    }

    // note we may not have all the votes from every person
    // e.g. may look like "fail", "undef.", "success"
    numOfPlayers = votes.length;

    let countSucceed = 0;
    let countFail = 0;

    let outcome;

    for (let i = 0; i < numOfPlayers; i++) {
        if (votes[i] === 'succeed') {
            // console.log("succeed");
            countSucceed++;
        } else if (votes[i] === 'fail') {
            // console.log("fail");
            countFail++;
        } else {
            // console.log("Bad vote: " + votes[i]);
        }
    }

    // calcuate the outcome
    if (countFail === 0) {
        outcome = 'succeeded';
    } else if (countFail === 1 && requiresTwoFails === true) {
        outcome = 'succeeded';
    } else {
        outcome = 'failed';
    }

    return outcome;
};


Game.prototype.checkRoleCardSpecialMoves = function (socket, data) {
    let foundSomething = false;

    for (var i = 0; i < this.roleKeysInPlay.length; i++) {
        // If the function doesn't exist, return null
        if (!this.specialRoles[this.roleKeysInPlay[i]].checkSpecialMove) { continue; }

        if (this.specialRoles[this.roleKeysInPlay[i]].checkSpecialMove(socket, data) === true) {
            foundSomething = true;
            break;
        }
    }
    // If we haven't found something in the roles, check the cards
    if (foundSomething === false) {
        for (var i = 0; i < this.cardKeysInPlay.length; i++) {
            // If the function doesn't exist, return null
            if (!this.specialCards[this.cardKeysInPlay[i]].checkSpecialMove) { continue; }

            if (this.specialCards[this.cardKeysInPlay[i]].checkSpecialMove(socket, data) === true) {
                foundSomething = true;
                break;
            }
        }
    }

    return foundSomething;
};


Game.prototype.getRoleCardPublicGameData = function () {
    const allData = {
        roles: {},
        cards: {},
    };
    for (var i = 0; i < this.roleKeysInPlay.length; i++) {
        // If the function doesn't exist, return null
        if (!this.specialRoles[this.roleKeysInPlay[i]].getPublicGameData) { continue; }

        const data = this.specialRoles[this.roleKeysInPlay[i]].getPublicGameData();
        Object.assign(allData.roles, data);
    }

    for (var i = 0; i < this.cardKeysInPlay.length; i++) {
        // If the function doesn't exist, return null
        if (!this.specialCards[this.cardKeysInPlay[i]].getPublicGameData) { continue; }

        const data = this.specialCards[this.cardKeysInPlay[i]].getPublicGameData();
        Object.assign(allData.cards, data);
    }


    return allData;
};


// If entries don't exist for current missionNum and pickNum, create them
Game.prototype.VHCheckUndefined = function () {
    for (let i = 0; i < this.playersInGame.length; i++) {
        if (this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1] === undefined) {
            this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1] = [];
        }
        if (this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] === undefined) {
            this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] = '';
        }
    }
};

Game.prototype.VHUpdateTeamPick = function () {
    this.VHCheckUndefined();

    for (let i = 0; i < this.playersInGame.length; i++) {
        if (this.proposedTeam.indexOf(this.playersInGame[i].request.user.username) !== -1) {
            this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += 'VHpicked ';
        }

        if (i === this.teamLeader) {
            this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += 'VHleader ';
        }
    }
};

Game.prototype.VHUpdateTeamVotes = function () {
    this.VHCheckUndefined();

    for (let i = 0; i < this.playersInGame.length; i++) {
        this.voteHistory[this.playersInGame[i].request.user.username][this.missionNum - 1][this.pickNum - 1] += (`VH${this.votes[i]}`);
    }
};

// console.log((new Game).__proto__);

Game.prototype.submitMerlinGuess = function (guesserUsername, targetUsername) {
    // Check Merlin is in play
    if (this.resRoles.indexOf('Merlin') === -1) {
        return 'This game does not include Merlin.';
    }

    if (!targetUsername) {
        return 'User not specified.';
    }
    const targetUsernameCase = this.playerUsernamesInGame.find((p) => p.toLowerCase() === targetUsername.toLowerCase());

    // Check the guesser isnt guessing himself
    if (guesserUsername === targetUsernameCase) {
        return 'You cannot guess yourself.';
    }

    // Check the target is even playing
    if (!targetUsernameCase) {
        return 'No such user is playing at your table.';
    }

    // Check the guesser isnt Merlin/Percy
    const guesserPlayer = this.playersInGame.find((player) => player.username === guesserUsername);
    if (guesserPlayer !== undefined && ['Merlin', 'Percival', 'Assassin'].indexOf(guesserPlayer.role) !== -1) {
        return `${guesserPlayer.role} cannot submit a guess.`;
    }

    // Accept the guess
    this.merlinguesses[guesserUsername] = targetUsernameCase;
    return `You have guessed that ${targetUsernameCase} is Merlin. Good luck!`;
};

Game.prototype.togglePause = function (modUsername) {
    // if paused, we unpause
    if (this.phase === 'paused') {
        this.sendText(this.allSockets, `Moderator ${modUsername} has unpaused the game.`, 'server-text');
        this.phase = this.phaseBeforePause;
        this.distributeGameData();
    }
    // if unpaused, we pause
    else {
        this.sendText(this.allSockets, `Moderator ${modUsername} has paused the game.`, 'server-text');
        // store the current phase, change to paused and update.
        this.phaseBeforePause = this.phase;
        this.phase = 'paused';
        this.distributeGameData();
    }
};

module.exports = Game;


// Helpful functions

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min)) + min; // The maximum is exclusive and the minimum is inclusive
}

function shuffle(array) {
    let currentIndex = array.length; let temporaryValue; let
        randomIndex;
    // While there remain elements to shuffle...
    while (currentIndex !== 0) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;
        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }
    return array;
}

function generateAssignmentOrders(num) {
    let rolesAssignment = [];

    // create the starting array for role assignment
    for (let i = 0; i < num; i++) {
        rolesAssignment[i] = i;
    }

    // shuffle
    rolesAssignment = shuffle(rolesAssignment);
    // console.log(rolesAssignment);

    return rolesAssignment;
}

function getAllSpies(thisRoom) {
    if (thisRoom.gameStarted === true) {
        const array = [];
        for (let i = 0; i < thisRoom.playersInGame.length; i++) {
            if (thisRoom.playersInGame[i].alliance === 'Spy') {
                array.push(thisRoom.playersInGame[i].username);
            }
        }
        return array;
    }

    return false;
}

function getRevealedRoles(thisRoom) {
    if (thisRoom.gameStarted === true && thisRoom.phase === 'finished') {
        const array = [];
        for (let i = 0; i < thisRoom.playersInGame.length; i++) {
            array.push(thisRoom.playersInGame[i].role);
        }
        return array;
    }
    return false;
}

function getUsernamesOfPlayersInRoom(thisRoom) {
    if (thisRoom.gameStarted === true) {
        const array = [];
        for (let i = 0; i < thisRoom.socketsOfPlayers.length; i++) {
            array.push(thisRoom.socketsOfPlayers[i].request.user.username);
        }
        return array;
    }

    return [];
}

function getUsernamesOfPlayersInGame(thisRoom) {
    if (thisRoom.gameStarted === true) {
        const array = [];
        for (let i = 0; i < thisRoom.playersInGame.length; i++) {
            array.push(thisRoom.playersInGame[i].request.user.username);
        }
        return array;
    }

    return [];
}

function gameReverseArray(arr) {
    if (arr.length == 0) {
        return [];
    }
    const firstEntry = arr.slice(0, 1);
    const remainder = arr.slice(1);
    const reversedRem = remainder.reverse();

    // console.log(firstEntry);
    // console.log(reversedRem);

    return firstEntry.concat(reversedRem);
}

function gameReverseIndex(num, numPlayers) {
    if (num == 0) {
        return 0;
    }

    return numPlayers - num;
}

const id = function (x) { return x; };

var reverseMapFromMap = function (map, f) {
    return Object.keys(map).reduce((acc, k) => {
        acc[map[k]] = (acc[map[k]] || []).concat((f || id)(k));
        return acc;
    }, {});
};
