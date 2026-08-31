/**
 * PCM Recorder AudioWorklet Processor
 * Phase B: Low-latency audio capture for Whisper ASR
 *
 * Captures audio at native sample rate and sends raw PCM Float32 chunks
 * directly to the main thread for WebSocket transmission.
 *
 * Benefits over MediaRecorder:
 * - No format encoding overhead (WebM/Opus)
 * - Direct Float32 PCM at Whisper's native 16kHz
 * - ~200ms latency reduction
 * - Configurable buffer size for latency/efficiency tradeoff
 */

class PCMRecorderProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // Configuration from options
        const processorOptions = options.processorOptions || {};

        // Buffer size in samples (default: 4096 = ~256ms at 16kHz)
        // Smaller = lower latency but more overhead
        // Larger = higher latency but more efficient
        this.bufferSize = processorOptions.bufferSize || 4096;

        // Accumulator for samples
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;

        // Track audio stats
        this.sampleCount = 0;
        this.peakLevel = 0;

        // Handle messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.type === 'flush') {
                this.flush();
            } else if (event.data.type === 'getStats') {
                this.port.postMessage({
                    type: 'stats',
                    sampleCount: this.sampleCount,
                    peakLevel: this.peakLevel
                });
            }
        };

        // Notify main thread that processor is ready
        this.port.postMessage({ type: 'ready' });
    }

    /**
     * Process audio samples from the audio graph
     * Called ~344 times/second with 128 samples each (at 44.1kHz)
     *
     * @param {Float32Array[][]} inputs - Input audio buffers
     * @param {Float32Array[][]} outputs - Output audio buffers (unused)
     * @returns {boolean} - True to keep processor alive
     */
    process(inputs) {
        const input = inputs[0];

        // Check if we have input audio
        if (!input || !input.length || !input[0] || !input[0].length) {
            return true;
        }

        // Get mono channel (first channel only)
        const samples = input[0];

        // Process each sample
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];

            // Track peak level for visualization
            const absValue = Math.abs(sample);
            if (absValue > this.peakLevel) {
                this.peakLevel = absValue;
            }

            // Add sample to buffer
            this.buffer[this.bufferIndex++] = sample;
            this.sampleCount++;

            // Send buffer when full
            if (this.bufferIndex >= this.bufferSize) {
                this.sendBuffer();
            }
        }

        // Decay peak level slowly for smoother visualization
        this.peakLevel *= 0.995;

        return true;
    }

    /**
     * Send accumulated buffer to main thread
     */
    sendBuffer() {
        if (this.bufferIndex === 0) return;

        // Create a copy of the buffer to send
        const chunk = this.buffer.slice(0, this.bufferIndex);

        // Send to main thread
        this.port.postMessage({
            type: 'audio',
            samples: chunk,
            peakLevel: this.peakLevel
        }, [chunk.buffer]); // Transfer ownership for efficiency

        // Reset buffer (need new array since we transferred the old one)
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
    }

    /**
     * Flush any remaining samples in buffer
     */
    flush() {
        if (this.bufferIndex > 0) {
            this.sendBuffer();
        }
        this.port.postMessage({ type: 'flushed' });
    }
}

// Register the processor
registerProcessor('pcm-recorder', PCMRecorderProcessor);
