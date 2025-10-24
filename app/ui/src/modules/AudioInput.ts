/**
 * Audio Input Module
 * Handles audio input from microphone or audio file
 */

export interface AudioAnalysis {
  frequencyData: Uint8Array;
  waveformData: Uint8Array;
  volume: number;
  timestamp: number;
}

export class AudioInput {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
  private rafId: number | null = null;
  private listeners: Set<(data: AudioAnalysis) => void> = new Set();

  /**
   * Initialize audio input from microphone
   */
  initMicrophone(stream: MediaStream): void {
    console.log('[AudioInput] Initializing microphone with stream...');

    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.source = this.audioContext.createMediaStreamSource(stream);
    this.source.connect(this.analyser);

    console.log('[AudioInput] Audio context created, starting analysis');
    this.startAnalysis();
  }

  /**
   * Initialize audio input from audio element
   */
  initAudioElement(audioElement: HTMLAudioElement): void {
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.source = this.audioContext.createMediaElementSource(audioElement);
    this.source.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.startAnalysis();
  }

  /**
   * Start analyzing audio data
   */
  private startAnalysis(): void {
    if (!this.analyser) return;


    const bufferLength = this.analyser.frequencyBinCount;
    const frequencyData = new Uint8Array(bufferLength);
    const waveformData = new Uint8Array(bufferLength);

    let frameCount = 0;

    const analyze = () => {
      if (!this.analyser) return;

      this.analyser.getByteFrequencyData(frequencyData);
      this.analyser.getByteTimeDomainData(waveformData);

      // Calculate volume
      const volume = frequencyData.reduce((sum, val) => sum + val, 0) / bufferLength / 255;

      const analysis: AudioAnalysis = {
        frequencyData: new Uint8Array(frequencyData),
        waveformData: new Uint8Array(waveformData),
        volume,
        timestamp: Date.now(),
      };

      frameCount++;

      this.notifyListeners(analysis);
      this.rafId = requestAnimationFrame(analyze);
    };

    analyze();
  }

  /**
   * Subscribe to audio analysis updates
   */
  subscribe(callback: (data: AudioAnalysis) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners
   */
  private notifyListeners(data: AudioAnalysis): void {
    this.listeners.forEach(listener => listener(data));
  }

  /**
   * Stop audio analysis and cleanup
   */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.listeners.clear();
  }
}
