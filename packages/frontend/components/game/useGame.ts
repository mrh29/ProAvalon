import { useEffect } from 'react';
import { useRouter } from 'next/router';
import socket from '../../socket';
import { SocketEvents } from '../../proto/lobbyProto';
import useAuth from '../../effects/useAuth';

const useGame = (gameId: string | string[]): void => {
  const user = useAuth();

  const router = useRouter();

  useEffect((): (() => void) => {
    if (Number.isNaN(Number(gameId))) {
      router.replace('/404');
    }

    if (user) {
      socket.emit(SocketEvents.JOIN_GAME, { id: gameId });
    }

    return (): void => {
      socket.emit(SocketEvents.LEAVE_GAME, { id: gameId });
    };
  }, [gameId, user]);
};

export default useGame;
