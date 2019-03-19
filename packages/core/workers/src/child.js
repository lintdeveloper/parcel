// @flow

import type {
  CallRequest,
  WorkerDataResponse,
  WorkerErrorResponse,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse
} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import {errorToJson, jsonToError} from '@parcel/utils/src/errorUtils';
import {serialize, deserialize} from '@parcel/utils/src/serializer';

type ChildCall = WorkerRequest & {|
  resolve: (result: Promise<any> | any) => void,
  reject: (error: any) => void
|};

class Child {
  callQueue: Array<ChildCall> = [];
  childId: ?number;
  maxConcurrentCalls: number = 10;
  module: ?any;
  responseId = 0;
  responseQueue: Map<number, ChildCall> = new Map();

  constructor() {
    if (!process.send) {
      throw new Error('Only create Child instances in a worker!');
    }
  }

  messageListener(data: string): void | Promise<void> {
    if (data === 'die') {
      return this.end();
    }

    let message: WorkerMessage = deserialize(data);
    if (message.type === 'response') {
      return this.handleResponse(message);
    } else if (message.type === 'request') {
      return this.handleRequest(message);
    }
  }

  async send(data: WorkerMessage): Promise<void> {
    let processSend = nullthrows(process.send).bind(process);
    processSend(serialize(data), err => {
      if (err && err instanceof Error) {
        if (err.code === 'ERR_IPC_CHANNEL_CLOSED') {
          // IPC connection closed
          // no need to keep the worker running if it can't send or receive data
          return this.end();
        }
      }
    });
  }

  childInit(module: any, childId: number): void {
    // $FlowFixMe this must be dynamic
    this.module = require(module);
    this.childId = childId;
  }

  async handleRequest(data: WorkerRequest): Promise<void> {
    let {idx, method, args} = data;
    let child = nullthrows(data.child);

    const responseFromContent = (content: any): WorkerDataResponse => ({
      idx,
      child,
      type: 'response',
      contentType: 'data',
      content
    });

    const errorResponseFromError = (e: Error): WorkerErrorResponse => ({
      idx,
      child,
      type: 'response',
      contentType: 'error',
      content: errorToJson(e)
    });

    let result;
    if (method === 'childInit') {
      try {
        result = responseFromContent(this.childInit(...args, child));
      } catch (e) {
        result = errorResponseFromError(e);
      }
    } else {
      try {
        // $FlowFixMe
        result = responseFromContent(await this.module[method](...args));
      } catch (e) {
        result = errorResponseFromError(e);
      }
    }

    this.send(result);
  }

  async handleResponse(data: WorkerResponse): Promise<void> {
    let idx = nullthrows(data.idx);
    let contentType = data.contentType;
    let content = data.content;
    let call = nullthrows(this.responseQueue.get(idx));

    if (contentType === 'error') {
      invariant(typeof content !== 'string');
      call.reject(jsonToError(content));
    } else {
      call.resolve(content);
    }

    this.responseQueue.delete(idx);

    // Process the next call
    this.processQueue();
  }

  // Keep in mind to make sure responses to these calls are JSON.Stringify safe
  async addCall(
    request: CallRequest,
    awaitResponse: boolean = true
  ): Promise<mixed> {
    // $FlowFixMe
    let call: ChildCall = {
      ...request,
      type: 'request',
      child: nullthrows(this.childId),
      awaitResponse,
      resolve: () => {},
      reject: () => {}
    };

    let promise;
    if (awaitResponse) {
      promise = new Promise((resolve, reject) => {
        call.resolve = resolve;
        call.reject = reject;
      });
    }

    this.callQueue.push(call);
    this.processQueue();

    return promise;
  }

  async sendRequest(call: ChildCall): Promise<void> {
    let idx;
    if (call.awaitResponse) {
      idx = this.responseId++;
      this.responseQueue.set(idx, call);
    }

    this.send({
      idx,
      child: call.child,
      type: call.type,
      location: call.location,
      method: call.method,
      args: call.args,
      awaitResponse: call.awaitResponse
    });
  }

  async processQueue(): Promise<void> {
    if (!this.callQueue.length) {
      return;
    }

    if (this.responseQueue.size < this.maxConcurrentCalls) {
      this.sendRequest(this.callQueue.shift());
    }
  }

  end(): void {
    process.exit();
  }
}

let child = new Child();
process.on('message', child.messageListener.bind(child));

module.exports = child;
