/* Broker factory — selects the execution venue from config. */
import { config } from '../config.js';
import { createPaperBroker } from './paperBroker.js';
import { createCcxtBroker } from './ccxtBroker.js';

export function createBroker() {
  switch (config.broker) {
    case 'ccxt': return createCcxtBroker();
    case 'paper':
    default: return createPaperBroker();
  }
}
