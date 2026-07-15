/**
 * Copyright (c) 2014 Jimb Esser
 * Released under the MIT license
 * http://opensource.org/licenses/mit-license.php
 */

/**
 * このソースは https://github.com/Jimbly/node-tail-stream
 * を改変し作成しています。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import { Readable, ReadableOptions } from 'stream';
import ILogger from '../model/ILogger';
import ILoggerModel from '../model/ILoggerModel';
import container from '../model/ModelContainer';

export interface TailStreamOption extends ReadableOptions {
    start?: number;
}

class TailStream extends Readable {
    private offset: number;
    private isClosed: boolean = false;
    private isFdClosed: boolean = false;
    private isFdCloseInProgress: boolean = false;
    private filePath: string;
    private readInProgress: boolean = false;
    private getFdInProgress: boolean = false;
    private getFdRetryTimer: NodeJS.Timeout | null = null;
    private checkIdleTimer: NodeJS.Timeout | null = null;
    private checkFileTimer: NodeJS.Timeout | null = null;
    private readPending: number = 0;
    private fd: number | null = null;
    private fdCloseError: NodeJS.ErrnoException | null = null;
    private fdCloseCallbacks: Array<(err: NodeJS.ErrnoException | null) => void> = [];

    private log: ILogger;

    constructor(filename: string, option: TailStreamOption) {
        super(option);

        this.filePath = filename;
        this.offset = option.start || 0;

        this.log = container.get<ILoggerModel>('ILoggerModel').getLogger();

        this.getFd();
    }

    private getFd(): void {
        assert.strictEqual(this.fd, null);
        assert.ok(!this.getFdInProgress);
        this.getFdInProgress = true;

        fs.open(this.filePath, 'r', (err, fd) => {
            assert.ok(this.getFdInProgress);
            this.getFdInProgress = false;
            if (err) {
                if (this.isClosed) {
                    this.tryCloseFd();
                    return;
                }

                // file doesn't exist (yet), try later
                if (this.readPending) {
                    // and we're inside of a _read call already, start a watcher to be notified
                    // when it exists
                    this.getFdRetryTimer = setTimeout(() => {
                        this.getFdRetryTimer = null;
                        if (this.isClosed) {
                            return;
                        }
                        this.getFd();
                    }, 1000);
                }
            } else {
                this.fd = fd;

                if (this.isClosed) {
                    this.tryCloseFd();
                    return;
                }

                if (this.readPending) {
                    this.doRead();
                }
            }
        });
    }

    private doRead(): void {
        assert.notStrictEqual(this.fd, null);
        assert.ok(this.readPending);
        assert.ok(!this.readInProgress);

        const fd = this.fd as number;
        this.readInProgress = true;
        fs.fstat(fd, (err, stat) => {
            if (this.isClosed) {
                this.readInProgress = false;
                this.tryCloseFd();
                return;
            }
            assert.ok(this.readInProgress);

            if (err) {
                this.readInProgress = false;
                // TODO: retry later, need to verify .fd is valid, check if .ino changed
                this.debug('error statting', err);
                this.destroy(err);

                return;
            }

            let start = this.offset;
            const end = stat.size;

            if (end < start) {
                // file was truncated
                start = 0;
            }

            assert.ok(this.readPending);
            const size = Math.min(this.readPending, end - start);
            if (size === 0) {
                // no data, try again later
                this.debug('no data to read');
                this.readInProgress = false;
                this.checkFile(); // ensure we're watching the file

                return;
            }

            const buffer = new Buffer(size);

            fs.read(fd, buffer, 0, size, start, (e, bytesRead, buff) => {
                assert.ok(this.readInProgress);
                this.readInProgress = false;
                if (this.isClosed) {
                    this.tryCloseFd();
                    return;
                }
                if (e) {
                    // Error, stop reading
                    this.debug('error reading', e);

                    this.destroy(e);
                    return;
                }

                if (bytesRead === 0) {
                    // no data, try again later
                    this.debug('no data read');
                    this.checkFile(); // ensure we're watching the file

                    return;
                }

                this.debug('read ' + bytesRead + ' bytes');
                this.readPending = 0;
                this.offset = start + bytesRead;
                // stream will call ._read again later (or immediately) to pump us for more data

                // Make sure if we do not get a ._read call again later, we clean ourselves up
                assert.ok(!this.checkIdleTimer);
                this.checkIdleTimer = setTimeout(() => {
                    this.checkIdle();
                }, 1000);

                // Must be very last, might recursively call into us!
                this.push(buff);

                return;
            });
        });
    }

    private checkFile(): void {
        if (this.isClosed || this.checkFileTimer !== null) {
            return;
        }

        let stat: fs.Stats;
        try {
            stat = fs.statSync(this.filePath);
        } catch (err: any) {
            this.destroy(err);
            return;
        }

        this.checkFileTimer = setTimeout(() => {
            this.checkFileTimer = null;

            if (this.isClosed) {
                return;
            }

            let newStat: fs.Stats;
            try {
                newStat = fs.statSync(this.filePath);
            } catch (err: any) {
                this.destroy(err);
                return;
            }

            if (newStat.size !== stat.size) {
                this.doRead();
            } else {
                this.close();
            }
        }, 1000);
    }

    private checkIdle(): void {
        if (this.isClosed) {
            return;
        }

        assert.ok(this.checkIdleTimer);
        this.checkIdleTimer = null;
        assert.ok(!this.readInProgress && !this.getFdInProgress);
        // If we get here, we're not reading anything, and haven't been asked to,
        // stop watching
        this.debug('timeout expired, closing watcher');
    }

    public _read(size: number): void {
        if (this.isClosed) {
            return;
        }

        assert.ok(!this.readPending);
        assert.ok(size);

        if (this.checkIdleTimer) {
            clearTimeout(this.checkIdleTimer);
            this.checkIdleTimer = null;
        }

        this.debug('read_pending = ' + size);
        this.readPending = size;
        if (this.fd === null) {
            if (this.getFdInProgress) {
                this.debug('waiting on fd');
                // Read will trigger read when getFd finishes
            } else {
                // last getFd must have failed, try again!
                this.getFd();
            }

            return;
        }
        this.doRead();
    }

    public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.beginClose(closeError => {
            if (error !== null && closeError !== null) {
                this.debug('error closing file', closeError);
            }
            callback(error === null ? closeError : error);
        });
    }

    private close(): void {
        if (this.isClosed) {
            return;
        }

        this.beginClose(err => {
            if (err !== null && !this.destroyed) {
                this.destroy(err);
            }
        });
        this.push(null);
    }

    private beginClose(callback: (err: NodeJS.ErrnoException | null) => void): void {
        if (this.isFdClosed) {
            callback(this.fdCloseError);
            return;
        }

        this.fdCloseCallbacks.push(callback);

        if (!this.isClosed) {
            this.isClosed = true;
            this.readPending = 0;
            this.clearTimers();
        }

        this.tryCloseFd();
    }

    private tryCloseFd(): void {
        if (
            !this.isClosed ||
            this.isFdClosed ||
            this.isFdCloseInProgress ||
            this.getFdInProgress ||
            this.readInProgress
        ) {
            return;
        }

        if (this.fd === null) {
            this.finishFdClose(null);
            return;
        }

        const fd = this.fd;
        this.fd = null;
        this.isFdCloseInProgress = true;
        fs.close(fd, err => {
            this.isFdCloseInProgress = false;
            this.finishFdClose(err);
        });
    }

    private finishFdClose(err: NodeJS.ErrnoException | null): void {
        if (this.isFdClosed) {
            return;
        }

        this.isFdClosed = true;
        this.fdCloseError = err;

        const callbacks = this.fdCloseCallbacks;
        this.fdCloseCallbacks = [];
        for (const callback of callbacks) {
            callback(err);
        }
    }

    private clearTimers(): void {
        if (this.getFdRetryTimer !== null) {
            clearTimeout(this.getFdRetryTimer);
            this.getFdRetryTimer = null;
        }
        if (this.checkIdleTimer !== null) {
            clearTimeout(this.checkIdleTimer);
            this.checkIdleTimer = null;
        }
        if (this.checkFileTimer !== null) {
            clearTimeout(this.checkFileTimer);
            this.checkFileTimer = null;
        }
    }

    private debug(str: string, err?: Error): void {
        if (err) {
            this.log.stream.error(str);
            this.log.stream.error(err);
        } else {
            // this.log.stream.debug(str);
        }
    }
}

export const createReadStream = (path: string, option: TailStreamOption): TailStream => {
    return new TailStream(path, option);
};
