(() => {
  "use strict";

  const TARGET_SAMPLE_RATE = 16000;
  // 10 minutes at 16 kHz 16-bit mono = 19.2 MB (~18.3 MiB), safely under Groq's 25 MB limit
  const DEFAULT_MAX_CHUNK_SECONDS = 600;

  /**
   * Downsample multi-channel Float32 PCM audio to 16 kHz 16-bit mono Int16Array
   * using box-filter averaging to avoid aliasing artifacts.
   */
  function downsampleTo16kMono(channelArrays, inputSampleRate, targetSampleRate = TARGET_SAMPLE_RATE) {
    if (!Array.isArray(channelArrays) || channelArrays.length === 0) {
      throw new Error("No audio channels to downsample");
    }
    const numChannels = channelArrays.length;
    const inputLen = channelArrays[0].length;
    if (!inputLen || !inputSampleRate || inputSampleRate <= 0) {
      throw new Error("Invalid audio buffer parameters");
    }

    const ratio = inputSampleRate / targetSampleRate;
    const outputLen = Math.max(1, Math.floor(inputLen / ratio));
    const out = new Int16Array(outputLen);

    for (let i = 0; i < outputLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(inputLen, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        let mono = 0;
        for (let c = 0; c < numChannels; c++) {
          mono += channelArrays[c][j] || 0;
        }
        sum += mono / numChannels;
        count += 1;
      }
      const sample = count > 0 ? sum / count : 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    }
    return out;
  }

  /**
   * Encode mono 16-bit PCM Int16Array into a standard 44-byte RIFF/WAVE ArrayBuffer.
   */
  function encodeWav16kMono(int16Samples, sampleRate = TARGET_SAMPLE_RATE) {
    const dataBytes = int16Samples.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
    view.setUint16(22, 1, true); // NumChannels = 1 (mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * 1 * 16/8
    view.setUint16(32, 2, true); // BlockAlign = 1 * 16/8
    view.setUint16(34, 16, true); // BitsPerSample
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);

    const pcmBytes = new Uint8Array(buf, 44);
    const srcBytes = new Uint8Array(int16Samples.buffer, int16Samples.byteOffset, dataBytes);
    pcmBytes.set(srcBytes);
    return buf;
  }

  /**
   * Slice Int16Array audio into <= maxChunkSeconds WAV chunks with exact time offsets.
   */
  function chunkInt16Audio(int16Samples, sampleRate = TARGET_SAMPLE_RATE, maxChunkSeconds = DEFAULT_MAX_CHUNK_SECONDS) {
    const maxSamples = Math.max(sampleRate, Math.floor(sampleRate * maxChunkSeconds));
    const chunks = [];
    for (let offset = 0, idx = 0; offset < int16Samples.length; offset += maxSamples, idx += 1) {
      const end = Math.min(int16Samples.length, offset + maxSamples);
      const slice = int16Samples.subarray(offset, end);
      chunks.push({
        index: idx,
        offsetSec: offset / sampleRate,
        durationSec: slice.length / sampleRate,
        wavBuffer: encodeWav16kMono(slice, sampleRate),
      });
    }
    return chunks;
  }

  /**
   * Merge chunked Whisper transcription results into a single continuous transcript.
   */
  function mergeChunkTranscripts(chunkResults) {
    const mergedSegments = [];
    const textParts = [];

    for (const chunk of chunkResults) {
      const offset = Number(chunk.offsetSec || 0);
      const rawSegs = Array.isArray(chunk.segments) ? chunk.segments : [];
      const cleaned = rawSegs
        .map((s) => ({
          start: Math.round((Number(s.start || 0) + offset) * 1000) / 1000,
          end: Math.round((Number(s.end || 0) + offset) * 1000) / 1000,
          text: String(s.text || "").trim(),
        }))
        .filter((s) => s.text);

      const chunkText = String(chunk.text || "").trim();
      if (cleaned.length > 0) {
        mergedSegments.push(...cleaned);
      } else if (chunkText) {
        mergedSegments.push({
          start: Math.round(offset * 1000) / 1000,
          end: Math.round((offset + Number(chunk.durationSec || 5)) * 1000) / 1000,
          text: chunkText,
        });
      }
      if (chunkText) textParts.push(chunkText);
    }

    return {
      text: textParts.join(" ").trim(),
      segments: mergedSegments,
    };
  }

  globalThis.IGCCAudioUtils = {
    TARGET_SAMPLE_RATE,
    DEFAULT_MAX_CHUNK_SECONDS,
    downsampleTo16kMono,
    encodeWav16kMono,
    chunkInt16Audio,
    mergeChunkTranscripts,
  };
})();
