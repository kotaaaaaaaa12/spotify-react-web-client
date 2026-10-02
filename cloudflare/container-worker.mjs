import { Container } from '@cloudflare/containers';
import worker from './worker.mjs';
export { PairingSession } from './pairing.mjs';

export class SpotifyPlayerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;
  #operations = Promise.resolve();
  #serialize(operation) {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }
  fetch(request) {
    // Only wait for response headers; streaming bodies remain concurrent.
    return this.#serialize(() => super.fetch(request));
  }
  async stopPlayer() {
    // Stopping an unused session must not provision a Container.
    return this.#serialize(async () => { if (this.container.running) await this.destroy(); });
  }
}

export default worker;
