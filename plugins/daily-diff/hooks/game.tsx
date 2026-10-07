import type { ClientModule } from 'claude-code'

import type { View } from '../types'

const Game: ClientModule<View> = (_props, surface) => {
  const { Text } = surface.elements

  return <Text>Daily Diff</Text>
}

export default Game
