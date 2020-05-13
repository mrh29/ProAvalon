import { ReactElement } from 'react';
import { useRouter } from 'next/router';

import GameIndex from '../../components/game/game';

const Game = (): ReactElement => {
  const router = useRouter();
  const { id } = router.query;

  return <GameIndex gameId={id} />;
};

export default Game;
