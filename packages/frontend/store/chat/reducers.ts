import { RootState } from '..';
import { SET_MESSAGES, RECEIVED_MESSAGE, ChatActionTypes } from './types';
import { ChatResponse } from '../../proto/lobbyProto';

export const chatSelector = (chatType: ChatType) => (
  state: RootState,
): ChatResponse[] => state.chat[chatType];

export type ChatType = keyof IChatState;

export interface IChatState {
  lobby: ChatResponse[];
  game: ChatResponse[];
}
const initialState: IChatState = {
  lobby: [],
  game: [],
};

const reducer = (
  state: IChatState = initialState,
  action: ChatActionTypes,
): IChatState => {
  switch (action.type) {
    case RECEIVED_MESSAGE: {
      const { chatType, message } = action.payload;

      return {
        ...state,
        [chatType]: state[chatType].concat(message),
      };
    }
    case SET_MESSAGES:
      return {
        ...state,
        [action.payload.chatType]: action.payload.messages,
      };
    default:
      return state;
  }
};

export default reducer;
