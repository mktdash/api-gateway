import { createServer, type IncomingMessage, type Server } from "node:http";

export type CapturedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
};

export type UpstreamBehaviour = {
  status: number;
  body: string;
  contentType: string;
  hang: boolean;
  delayMs: number;
};

export class UpstreamStub {
  readonly requests: CapturedRequest[] = [];

  behaviour: UpstreamBehaviour = {
    status: 202,
    body: JSON.stringify({ status: "verification-required" }),
    contentType: "application/json",
    hang: false,
    delayMs: 0,
  };

  #server: Server | undefined;
  #port: number | undefined;

  get lastRequest(): CapturedRequest | undefined {
    return this.requests.at(-1);
  }

  get port(): number {
    if (this.#port === undefined) {
      throw new Error("UpstreamStub.start() has not completed");
    }
    return this.#port;
  }

  get origin(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.behaviour = {
      status: 202,
      body: JSON.stringify({ status: "verification-required" }),
      contentType: "application/json",
      hang: false,
      delayMs: 0,
    };
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#collect(request).then((body) => {
        this.requests.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: { ...request.headers },
          body,
        });

        if (this.behaviour.hang) {
          request.destroy();
          return;
        }

        const answer = (): void => {
          response.writeHead(this.behaviour.status, {
            "content-type": this.behaviour.contentType,
          });
          response.end(this.behaviour.body);
        };

        if (this.behaviour.delayMs > 0) {
          setTimeout(answer, this.behaviour.delayMs);
          return;
        }

        answer();
      });
    });

    const server = this.#server;

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("UpstreamStub did not bind a TCP port");
    }

    this.#port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }

    this.#server = undefined;
    this.#port = undefined;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }

  async #collect(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
