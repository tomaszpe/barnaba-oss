/**
 * Audio Quality Service
 * Phase 6: Audio quality monitoring with VAD and SNR analysis
 *
 * Provides:
 * - RMS (Root Mean Square) level calculation
 * - dB (Decibel) level measurement
 * - SNR (Signal-to-Noise Ratio) estimation
 * - VAD (Voice Activity Detection)
 * - Audio quality scoring and recommendations
 */

// Configuration
const CONFIG = {
    // VAD settings
    vadThreshold: 0.02,           // Energy threshold for voice detection
    vadFrameSize: 512,            // Samples per frame for VAD analysis
    vadMinSpeechFrames: 3,        // Minimum consecutive frames to confirm speech

    // Audio quality thresholds
    minAcceptableRMS: 0.01,       // Minimum RMS for audible signal
    maxAcceptableRMS: 0.9,        // Maximum RMS before clipping
    targetRMS: 0.2,               // Target RMS for optimal level
    minAcceptableSNR: 10,         // Minimum acceptable SNR in dB
    goodSNR: 20,                  // Good SNR in dB
    excellentSNR: 30,             // Excellent SNR in dB

    // Noise estimation
    noiseEstimationFrames: 10,    // Frames to use for noise floor estimation
    noiseUpdateRate: 0.1,         // Rate of noise floor update (0-1)

    // Sample rate (default, can be overridden)
    defaultSampleRate: 16000
};

/**
 * Calculate RMS (Root Mean Square) of audio samples
 * @param {Float32Array|Array} samples - Audio samples
 * @returns {number} RMS value (0-1)
 */
export function calculateRMS(samples) {
    if (!samples || samples.length === 0) {
        return 0;
    }

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
    }

    return Math.sqrt(sumSquares / samples.length);
}

/**
 * Convert RMS to decibels (dBFS - decibels relative to full scale)
 * @param {number} rms - RMS value
 * @returns {number} dB value (negative, 0 = full scale)
 */
export function rmsToDecibels(rms) {
    if (rms <= 0) {
        return -Infinity;
    }
    return 20 * Math.log10(rms);
}

/**
 * Convert decibels to RMS
 * @param {number} db - Decibel value
 * @returns {number} RMS value
 */
export function decibelsToRMS(db) {
    return Math.pow(10, db / 20);
}

/**
 * Estimate noise floor from quiet segments
 * @param {Float32Array|Array} samples - Audio samples
 * @param {number} frameSize - Size of analysis frame
 * @returns {number} Estimated noise floor RMS
 */
export function estimateNoiseFloor(samples, frameSize = CONFIG.vadFrameSize) {
    if (!samples || samples.length < frameSize) {
        return 0;
    }

    const frameCount = Math.floor(samples.length / frameSize);
    const frameRMS = [];

    // Calculate RMS for each frame
    for (let i = 0; i < frameCount; i++) {
        const frameStart = i * frameSize;
        const frame = samples.slice(frameStart, frameStart + frameSize);
        frameRMS.push(calculateRMS(frame));
    }

    // Sort and take lowest 20% as noise estimate
    frameRMS.sort((a, b) => a - b);
    const noiseFrameCount = Math.max(1, Math.floor(frameRMS.length * 0.2));
    const noiseFrames = frameRMS.slice(0, noiseFrameCount);

    // Average of quietest frames
    return noiseFrames.reduce((sum, rms) => sum + rms, 0) / noiseFrames.length;
}

/**
 * Calculate SNR (Signal-to-Noise Ratio)
 * @param {number} signalRMS - RMS of signal
 * @param {number} noiseRMS - RMS of noise floor
 * @returns {number} SNR in decibels
 */
export function calculateSNR(signalRMS, noiseRMS) {
    if (noiseRMS <= 0 || signalRMS <= 0) {
        return 0;
    }
    return 20 * Math.log10(signalRMS / noiseRMS);
}

/**
 * Analyze audio quality
 * @param {Float32Array|Array} samples - Audio samples
 * @param {number} sampleRate - Sample rate in Hz
 * @returns {object} Quality analysis result
 */
export function analyzeAudioQuality(samples, sampleRate = CONFIG.defaultSampleRate) {
    if (!samples || samples.length === 0) {
        return {
            valid: false,
            error: 'No audio samples provided'
        };
    }

    const rms = calculateRMS(samples);
    const dB = rmsToDecibels(rms);
    const noiseFloor = estimateNoiseFloor(samples);
    const noiseDB = rmsToDecibels(noiseFloor);
    const snr = calculateSNR(rms, noiseFloor);

    // Peak detection
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
    }
    const peakDB = rmsToDecibels(peak);

    // Dynamic range
    const dynamicRange = peakDB - noiseDB;

    // Quality scoring
    const qualityScore = calculateQualityScore(rms, snr, peak);

    // Issues detection
    const issues = detectAudioIssues(rms, snr, peak);

    return {
        valid: true,
        rms: rms,
        dB: dB,
        peak: peak,
        peakDB: peakDB,
        noiseFloor: noiseFloor,
        noiseDB: noiseDB,
        snr: snr,
        dynamicRange: dynamicRange,
        qualityScore: qualityScore,
        qualityLevel: getQualityLevel(qualityScore),
        issues: issues,
        recommendations: generateRecommendations(issues),
        duration: samples.length / sampleRate,
        sampleCount: samples.length
    };
}

/**
 * Calculate overall quality score (0-100)
 * @param {number} rms - RMS level
 * @param {number} snr - SNR in dB
 * @param {number} peak - Peak level
 * @returns {number} Quality score 0-100
 */
function calculateQualityScore(rms, snr, peak) {
    let score = 100;

    // Level scoring (optimal around 0.2 RMS)
    if (rms < CONFIG.minAcceptableRMS) {
        score -= 30 * (1 - rms / CONFIG.minAcceptableRMS);
    } else if (rms > CONFIG.maxAcceptableRMS) {
        score -= 40; // Clipping is severe
    } else if (rms < CONFIG.targetRMS * 0.5) {
        score -= 15;
    } else if (rms > CONFIG.targetRMS * 2) {
        score -= 10;
    }

    // SNR scoring
    if (snr < CONFIG.minAcceptableSNR) {
        score -= 30 * (1 - snr / CONFIG.minAcceptableSNR);
    } else if (snr < CONFIG.goodSNR) {
        score -= 10;
    } else if (snr >= CONFIG.excellentSNR) {
        score += 5; // Bonus for excellent SNR
    }

    // Clipping penalty
    if (peak >= 0.99) {
        score -= 20;
    } else if (peak >= 0.95) {
        score -= 10;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Get quality level string from score
 * @param {number} score - Quality score
 * @returns {string} Quality level
 */
function getQualityLevel(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 50) return 'acceptable';
    if (score >= 25) return 'poor';
    return 'unusable';
}

/**
 * Detect audio issues
 * @param {number} rms - RMS level
 * @param {number} snr - SNR in dB
 * @param {number} peak - Peak level
 * @returns {Array} Array of detected issues
 */
function detectAudioIssues(rms, snr, peak) {
    const issues = [];

    if (rms < CONFIG.minAcceptableRMS) {
        issues.push({
            type: 'too_quiet',
            severity: 'high',
            message: 'Audio level too low'
        });
    }

    if (peak >= 0.99) {
        issues.push({
            type: 'clipping',
            severity: 'high',
            message: 'Audio is clipping (distortion)'
        });
    } else if (peak >= 0.95) {
        issues.push({
            type: 'near_clipping',
            severity: 'medium',
            message: 'Audio near clipping threshold'
        });
    }

    if (snr < CONFIG.minAcceptableSNR) {
        issues.push({
            type: 'high_noise',
            severity: 'high',
            message: 'High background noise'
        });
    } else if (snr < CONFIG.goodSNR) {
        issues.push({
            type: 'moderate_noise',
            severity: 'low',
            message: 'Moderate background noise'
        });
    }

    return issues;
}

/**
 * Generate recommendations based on issues
 * @param {Array} issues - Detected issues
 * @returns {Array} Array of recommendations
 */
function generateRecommendations(issues) {
    const recommendations = [];

    for (const issue of issues) {
        switch (issue.type) {
            case 'too_quiet':
                recommendations.push('Move closer to the microphone or increase input gain');
                break;
            case 'clipping':
                recommendations.push('Reduce input gain or move away from microphone');
                break;
            case 'near_clipping':
                recommendations.push('Slightly reduce input gain to prevent distortion');
                break;
            case 'high_noise':
                recommendations.push('Move to a quieter location or use noise reduction');
                break;
            case 'moderate_noise':
                recommendations.push('Consider reducing ambient noise if possible');
                break;
        }
    }

    return recommendations;
}

/**
 * Voice Activity Detection (VAD)
 * Detects presence of speech in audio
 * @param {Float32Array|Array} samples - Audio samples
 * @param {number} threshold - Energy threshold (default from config)
 * @returns {object} VAD result
 */
export function detectVoiceActivity(samples, threshold = CONFIG.vadThreshold) {
    if (!samples || samples.length === 0) {
        return {
            hasSpeech: false,
            confidence: 0,
            speechRatio: 0,
            frames: []
        };
    }

    const frameSize = CONFIG.vadFrameSize;
    const frameCount = Math.floor(samples.length / frameSize);
    const frames = [];

    let speechFrames = 0;
    let totalEnergy = 0;

    // Analyze each frame
    for (let i = 0; i < frameCount; i++) {
        const frameStart = i * frameSize;
        const frame = samples.slice(frameStart, frameStart + frameSize);
        const energy = calculateRMS(frame);
        const isSpeech = energy > threshold;

        frames.push({
            index: i,
            energy: energy,
            isSpeech: isSpeech
        });

        totalEnergy += energy;
        if (isSpeech) speechFrames++;
    }

    // Calculate statistics
    const speechRatio = frameCount > 0 ? speechFrames / frameCount : 0;
    const avgEnergy = frameCount > 0 ? totalEnergy / frameCount : 0;

    // Determine speech presence with hysteresis
    const hasSpeech = speechFrames >= CONFIG.vadMinSpeechFrames;

    // Calculate confidence based on energy consistency
    const confidence = calculateVADConfidence(frames, threshold);

    return {
        hasSpeech: hasSpeech,
        confidence: confidence,
        speechRatio: speechRatio,
        avgEnergy: avgEnergy,
        frameCount: frameCount,
        speechFrameCount: speechFrames,
        frames: frames
    };
}

/**
 * Calculate VAD confidence
 * @param {Array} frames - Analyzed frames
 * @param {number} threshold - Energy threshold
 * @returns {number} Confidence 0-1
 */
function calculateVADConfidence(frames, threshold) {
    if (frames.length === 0) return 0;

    const speechFrames = frames.filter(f => f.isSpeech);
    if (speechFrames.length === 0) return 0;

    // Higher confidence if speech frames have energy well above threshold
    const avgSpeechEnergy = speechFrames.reduce((sum, f) => sum + f.energy, 0) / speechFrames.length;
    const energyRatio = avgSpeechEnergy / threshold;

    // Higher confidence with more consecutive speech frames
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    for (const frame of frames) {
        if (frame.isSpeech) {
            currentConsecutive++;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
            currentConsecutive = 0;
        }
    }
    const consecutiveRatio = maxConsecutive / frames.length;

    // Combine factors
    const confidence = Math.min(1, (Math.min(energyRatio, 3) / 3) * 0.6 + consecutiveRatio * 0.4);

    return Math.round(confidence * 100) / 100;
}

/**
 * Detect speech segments in audio
 * @param {Float32Array|Array} samples - Audio samples
 * @param {number} sampleRate - Sample rate in Hz
 * @param {number} threshold - Energy threshold
 * @returns {Array} Array of speech segments {start, end, duration}
 */
export function detectSpeechSegments(samples, sampleRate = CONFIG.defaultSampleRate, threshold = CONFIG.vadThreshold) {
    const vad = detectVoiceActivity(samples, threshold);
    const segments = [];
    const frameDuration = CONFIG.vadFrameSize / sampleRate;

    let segmentStart = null;

    for (let i = 0; i < vad.frames.length; i++) {
        const frame = vad.frames[i];
        const frameTime = i * frameDuration;

        if (frame.isSpeech && segmentStart === null) {
            // Start of speech segment
            segmentStart = frameTime;
        } else if (!frame.isSpeech && segmentStart !== null) {
            // End of speech segment
            segments.push({
                start: segmentStart,
                end: frameTime,
                duration: frameTime - segmentStart
            });
            segmentStart = null;
        }
    }

    // Handle segment continuing to end
    if (segmentStart !== null) {
        const endTime = vad.frames.length * frameDuration;
        segments.push({
            start: segmentStart,
            end: endTime,
            duration: endTime - segmentStart
        });
    }

    return segments;
}

/**
 * Audio Quality Monitor class for continuous monitoring
 */
export class AudioQualityMonitor {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || CONFIG.defaultSampleRate;
        this.historySize = options.historySize || 100;
        this.history = [];
        this.noiseFloorEstimate = 0;
        this.lastAnalysis = null;
    }

    /**
     * Process audio buffer and update monitoring
     * @param {Float32Array|Array} samples - Audio samples
     * @returns {object} Current analysis
     */
    process(samples) {
        const analysis = analyzeAudioQuality(samples, this.sampleRate);
        const vad = detectVoiceActivity(samples);

        // Update noise floor estimate during non-speech
        if (!vad.hasSpeech) {
            const newNoiseFloor = estimateNoiseFloor(samples);
            if (this.noiseFloorEstimate === 0) {
                this.noiseFloorEstimate = newNoiseFloor;
            } else {
                this.noiseFloorEstimate =
                    this.noiseFloorEstimate * (1 - CONFIG.noiseUpdateRate) +
                    newNoiseFloor * CONFIG.noiseUpdateRate;
            }
        }

        // Create combined result
        const result = {
            ...analysis,
            vad: vad,
            estimatedNoiseFloor: this.noiseFloorEstimate,
            timestamp: Date.now()
        };

        // Update history
        this.history.push(result);
        if (this.history.length > this.historySize) {
            this.history.shift();
        }

        this.lastAnalysis = result;
        return result;
    }

    /**
     * Get average quality over recent history
     * @returns {object} Average metrics
     */
    getAverageQuality() {
        if (this.history.length === 0) {
            return null;
        }

        const sum = {
            rms: 0,
            snr: 0,
            qualityScore: 0,
            speechRatio: 0
        };

        for (const entry of this.history) {
            sum.rms += entry.rms;
            sum.snr += entry.snr;
            sum.qualityScore += entry.qualityScore;
            sum.speechRatio += entry.vad.speechRatio;
        }

        const count = this.history.length;
        return {
            avgRMS: sum.rms / count,
            avgSNR: sum.snr / count,
            avgQualityScore: Math.round(sum.qualityScore / count),
            avgSpeechRatio: sum.speechRatio / count,
            sampleCount: count
        };
    }

    /**
     * Reset monitor state
     */
    reset() {
        this.history = [];
        this.noiseFloorEstimate = 0;
        this.lastAnalysis = null;
    }

    /**
     * Get current status
     * @returns {object} Monitor status
     */
    getStatus() {
        return {
            historySize: this.history.length,
            maxHistorySize: this.historySize,
            noiseFloorEstimate: this.noiseFloorEstimate,
            lastAnalysisTimestamp: this.lastAnalysis?.timestamp || null
        };
    }
}

/**
 * Get audio service statistics
 * @returns {object} Configuration and stats
 */
export function getAudioServiceStats() {
    return {
        config: { ...CONFIG },
        version: '1.0.0'
    };
}

export default {
    calculateRMS,
    rmsToDecibels,
    decibelsToRMS,
    estimateNoiseFloor,
    calculateSNR,
    analyzeAudioQuality,
    detectVoiceActivity,
    detectSpeechSegments,
    AudioQualityMonitor,
    getAudioServiceStats
};
