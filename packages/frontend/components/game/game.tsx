import { ReactElement } from 'react';
import Layout from '../layout/layout';
import TabPane from './tabPane';
import useGame from './useGame';

interface IGameProps {
  gameId: string | string[];
}

const GameIndex = ({ gameId }: IGameProps): ReactElement => {
  useGame(gameId);

  return (
    <Layout>
      <div style={{ flex: 1 }}>Game {gameId} Content</div>
      <div style={{ flex: 1, display: 'flex' }}>
        <div style={{ flex: 1, padding: '1rem' }}>
          <TabPane />
        </div>
        <div style={{ flex: 1, padding: '1rem' }}>
          <TabPane />
        </div>
      </div>
    </Layout>
  );
};

export default GameIndex;
