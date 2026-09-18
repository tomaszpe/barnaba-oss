(function (global) {
    'use strict';

    const DB_NAME = 'barnaba-listener-qa';
    const DB_VERSION = 2;
    const STORE = 'records';
    const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

    const requestResult = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });

    class IndexedDbQaStore {
        async open() {
            if (!global.indexedDB) throw new Error('IndexedDB is unavailable');
            const request = global.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
                db.createObjectStore(STORE, { keyPath: 'id' });
            };
            this.db = await requestResult(request);
        }

        async put(record) {
            if (!this.db) await this.open();
            return requestResult(this.db.transaction(STORE, 'readwrite').objectStore(STORE).put(record));
        }

        async get(id) {
            if (!this.db) await this.open();
            return requestResult(this.db.transaction(STORE).objectStore(STORE).get(id));
        }

        async getAll() {
            if (!this.db) await this.open();
            return requestResult(this.db.transaction(STORE).objectStore(STORE).getAll());
        }

        async deleteMany(ids) {
            if (!ids.length) return;
            if (!this.db) await this.open();
            const transaction = this.db.transaction(STORE, 'readwrite');
            for (const id of ids) transaction.objectStore(STORE).delete(id);
            await new Promise((resolve, reject) => {
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new Error('IndexedDB delete failed'));
                transaction.onabort = () => reject(transaction.error || new Error('IndexedDB delete aborted'));
            });
        }

        async listRecording(recordingId) {
            return (await this.getAll()).filter(record => record.recordingId === recordingId);
        }

        async deleteRecording(recordingId) {
            const records = await this.listRecording(recordingId);
            await this.deleteMany(records.map(record => record.id));
        }

        async sweepExpired(cutoffMs) {
            const records = await this.getAll();
            const sessions = records.filter(record => record.type === 'session');
            const knownIds = new Set(sessions.map(record => record.recordingId));
            const expiredIds = new Set(sessions
                .filter(record => Number(record.startedAt) < cutoffMs)
                .map(record => record.recordingId));
            await this.deleteMany(records.filter(record => expiredIds.has(record.recordingId) || !knownIds.has(record.recordingId)).map(record => record.id));
            return expiredIds.size;
        }
    }

    const decodeBase64 = value => {
        const binary = global.atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: 'audio/mpeg' });
    };

    class QaReplayCapture {
        constructor({ store = new IndexedDbQaStore(), now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
            this.store = store;
            this.now = now;
            this.ttlMs = ttlMs;
            this.session = null;
            this.pendingWrites = new Set();
            this.persistenceError = null;
        }

        get active() { return this.session?.state === 'recording'; }

        _persist(record) {
            const promise = Promise.resolve(this.store.put(record));
            this.pendingWrites.add(promise);
            promise.then(
                () => this.pendingWrites.delete(promise),
                error => { this.pendingWrites.delete(promise); this.persistenceError = error; }
            );
            return promise;
        }

        async _flushWrites() {
            await Promise.allSettled([...this.pendingWrites]);
            if (this.persistenceError) throw new Error(`QA storage failed: ${this.persistenceError.message}`);
        }

        _sessionRecord() {
            return { ...this.session, id: `${this.session.recordingId}:session`, type: 'session' };
        }

        async start({ churchId, language }) {
            await this.store.sweepExpired(this.now() - this.ttlMs);
            const recordingId = global.crypto?.randomUUID?.() || `qa-${this.now()}-${Math.random().toString(36).slice(2)}`;
            this.session = { recordingId, churchId, language, state: 'recording', startedAt: this.now(), partial: false };
            await this._persist(this._sessionRecord());
            return recordingId;
        }

        async recoverLatest() {
            await this.store.sweepExpired(this.now() - this.ttlMs);
            const sessions = (await this.store.getAll()).filter(record => record.type === 'session');
            if (!sessions.length) return null;
            const recovered = sessions.sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0];
            this.session = { recordingId: recovered.recordingId, churchId: recovered.churchId, language: recovered.language, state: recovered.state, startedAt: recovered.startedAt, stoppedAt: recovered.stoppedAt, partial: recovered.partial };
            if (this.session.state !== 'ready') {
                this.session.state = 'ready';
                this.session.partial = true;
                this.session.recoveredAt = this.now();
                await this._persist(this._sessionRecord());
            }
            return this.session;
        }

        async captureChunk(chunkKey, audioBase64, metadata = {}) {
            if (!this.active || !audioBase64) return;
            const id = `${this.session.recordingId}:chunk:${chunkKey}`;
            if (await this.store.get(id)) return;
            await this._persist({ id, type: 'chunk', recordingId: this.session.recordingId, chunkKey, audio: decodeBase64(audioBase64), ...metadata });
        }

        async recordDrop(chunkKey, reason, metadata = {}) {
            if (!this.active) return;
            const id = `${this.session.recordingId}:drop:${this.now()}:${Math.random().toString(36).slice(2)}`;
            await this._persist({ id, type: 'drop', recordingId: this.session.recordingId, chunkKey, reason, at: this.now(), ...metadata });
        }

        async recordPlayStart(chunkKey, facts = {}) {
            if (!this.active) return null;
            const id = `${this.session.recordingId}:play:${this.now()}:${Math.random().toString(36).slice(2)}`;
            await this._persist({ id, type: 'play', recordingId: this.session.recordingId, chunkKey, playStartAt: this.now(), playEndAt: null, ...facts });
            return id;
        }

        async recordPlayEnd(playId, facts = {}) {
            if (!this.session || !playId) return;
            const play = await this.store.get(playId);
            if (!play) return;
            await this._persist({ ...play, playEndAt: this.now(), ...facts });
        }

        async stop({ waitUntilIdle, timeoutMs = 45000 }) {
            if (!this.session) throw new Error('No QA recording');
            this.session.state = 'draining';
            await this._persist(this._sessionRecord());
            const deadline = this.now() + timeoutMs;
            while (!waitUntilIdle() && this.now() < deadline) await new Promise(resolve => global.setTimeout(resolve, 100));
            this.session.partial = !waitUntilIdle();
            this.session.state = 'ready';
            this.session.stoppedAt = this.now();
            await this._flushWrites();
            await this._persist(this._sessionRecord());
            return this.session;
        }

        async upload(url = '/api/listener-qa-replay') {
            if (!this.session || this.session.state !== 'ready') throw new Error('QA recording is not ready');
            this.session.state = 'uploading';
            await this._persist(this._sessionRecord());
            await this._flushWrites();
            const records = await this.store.listRecording(this.session.recordingId);
            const chunks = new Map(records.filter(record => record.type === 'chunk').map(record => [record.chunkKey, record]));
            const plays = records.filter(record => record.type === 'play').sort((a, b) => a.playStartAt - b.playStartAt);
            const completed = plays.filter(play => Number.isFinite(play.playEndAt) && chunks.has(play.chunkKey));
            const incompletePlayWindows = plays.length - completed.length;
            const exportPartial = this.session.partial || incompletePlayWindows > 0;
            const form = new FormData();
            form.append('manifest', JSON.stringify({
                recordingId: this.session.recordingId,
                churchId: this.session.churchId,
                language: this.session.language,
                partial: exportPartial,
                receivedAudioChunks: chunks.size,
                incompletePlayWindows,
                plays: completed,
                drops: records.filter(record => record.type === 'drop'),
            }));
            for (const chunkKey of new Set(completed.map(play => play.chunkKey))) {
                form.append('audio', chunks.get(chunkKey).audio, `${encodeURIComponent(chunkKey)}.mp3`);
            }
            const response = await global.fetch(url, { method: 'POST', body: form, credentials: 'same-origin' });
            if (!response.ok) {
                this.session.state = 'ready';
                await this._persist(this._sessionRecord());
                throw new Error(`QA render failed (${response.status})`);
            }
            const blob = await response.blob();
            const reportHeader = response.headers.get('X-QA-Report');
            let report = null;
            if (reportHeader) {
                try {
                    let base64 = reportHeader.replace(/-/g, '+').replace(/_/g, '/');
                    base64 += '='.repeat((4 - base64.length % 4) % 4);
                    report = JSON.parse(global.atob(base64));
                } catch { report = null; }
            }
            this.session.state = 'ready';
            await this._persist(this._sessionRecord());
            return { blob, filename: response.headers.get('X-QA-Filename') || `barnaba_qa_${this.session.language}.mp3`, partial: exportPartial, report };
        }

        async clear() {
            if (!this.session) return;
            await this.store.deleteRecording(this.session.recordingId);
            this.session = null;
        }
    }

    global.BarnabaQaReplay = { QaReplayCapture, IndexedDbQaStore, DEFAULT_TTL_MS };
})(window);
