/**
 * GLSL Renderer Module
 * Renders GLSL shaders using glslCanvas
 */

import GlslCanvas from 'glslCanvas';
import type { AudioAnalysis } from './AudioInput';

export class GLSLRenderer {
  private canvas: HTMLCanvasElement;
  private sandbox: GlslCanvas | null = null;
  private currentShader: string = '';

  constructor(canvas: HTMLCanvasElement) {
    console.log('[GLSLRenderer] Constructor called');
    this.canvas = canvas;
    this.init();
  }

  /**
   * Initialize the GLSL canvas
   */
  private init(): void {
    console.log('[GLSLRenderer] Initializing...');
    // Set canvas size to match window
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    // Initialize with default shader
    console.log('[GLSLRenderer] Creating GlslCanvas instance');
    this.sandbox = new GlslCanvas(this.canvas);
    console.log('[GLSLRenderer] GlslCanvas created:', this.sandbox);
    this.loadDefaultShader();
    console.log('[GLSLRenderer] Initialization complete');
  }

  /**
   * Resize canvas to match window size
   */
  private resizeCanvas(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * Load default shader
   */
  private loadDefaultShader(): void {
    const defaultShader = `
#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;

void main() {
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    vec3 color = vec3(0.0);

    // Animated gradient
    color.r = abs(sin(u_time * 0.5 + st.x * 3.0));
    color.g = abs(sin(u_time * 0.3 + st.y * 2.0));
    color.b = abs(sin(u_time * 0.7));

    gl_FragColor = vec4(color, 1.0);
}`;
    this.updateShader(defaultShader);
  }

  /**
   * Update the shader code
   * Returns true if successful, false if compilation error
   */
  updateShader(shaderCode: string): Promise<boolean> {
    console.log('[GLSLRenderer] updateShader called');
    console.log('[GLSLRenderer] this.sandbox:', this.sandbox);
    console.log('[GLSLRenderer] Shader code length:', shaderCode?.length || 0);
    console.log('[GLSLRenderer] Received shader code:');
    console.log(shaderCode);

    if (!this.sandbox) {
      console.error('[GLSLRenderer] Sandbox not initialized');
      console.error('[GLSLRenderer] this:', this);
      return Promise.resolve(false);
    }

    if (shaderCode === this.currentShader) {
      console.log('[GLSLRenderer] Shader unchanged, skipping update');
      return Promise.resolve(true);
    }

    try {
      // Ensure shader has proper precision statement
      let processedShader = shaderCode;
      if (!processedShader.includes('precision')) {
        console.log('[GLSLRenderer] Adding precision statement');
        processedShader = `#ifdef GL_ES
precision mediump float;
#endif

` + processedShader;
      }

      console.log('[GLSLRenderer] Loading shader into glslCanvas...');

      // Store the previous shader code in case we need to rollback
      const previousShader = this.currentShader;

      // Capture console errors to detect compilation issues
      const originalError = console.error;
      let hadError = false;
      let errorMessage = '';

      console.error = (...args: any[]) => {
        const message = args.join(' ');
        if (message.includes('Error compiling shader') || message.includes('syntax error') || message.includes('ERROR:')) {
          hadError = true;
          errorMessage = message;
        }
        originalError.apply(console, args);
      };

      this.sandbox.load(processedShader);

      // Return promise to wait for potential async errors
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          console.error = originalError;

          if (hadError) {
            console.error('[GLSLRenderer] Shader compilation failed:', errorMessage);
            console.log('[GLSLRenderer] Rolling back to previous shader');

            // Rollback to previous shader if we had one
            if (previousShader) {
              this.sandbox!.load(previousShader);
            }

            resolve(false);
          } else {
            this.currentShader = shaderCode;
            console.log('[GLSLRenderer] Shader updated successfully');
            resolve(true);
          }
        }, 200);
      });
    } catch (error) {
      console.error('[GLSLRenderer] Failed to load shader:', error);
      return Promise.resolve(false);
    }
  }

  /**
   * Set uniform value
   */
  setUniform(name: string, value: number | number[]): void {
    if (!this.sandbox) return;

    try {
      this.sandbox.setUniform(name, value);
    } catch (error) {
      console.error(`Failed to set uniform ${name}:`, error);
    }
  }

  /**
   * Update audio data uniforms
   */
  updateAudioData(audioData: AudioAnalysis, sensitivity: number = 1.0): void {
    if (!this.sandbox) return;

    // Calculate frequency band energies
    const bassEnergy = this.getFrequencyBandEnergy(audioData.frequencyData, 0, 0.1);
    const midEnergy = this.getFrequencyBandEnergy(audioData.frequencyData, 0.1, 0.5);
    const highEnergy = this.getFrequencyBandEnergy(audioData.frequencyData, 0.5, 1.0);

    // Apply sensitivity multiplier and clamp to 0-1
    const clamp = (value: number) => Math.min(1.0, Math.max(0.0, value * sensitivity));

    // Set uniforms for GLSL shader
    this.setUniform('u_volume', clamp(audioData.volume));
    this.setUniform('u_bass', clamp(bassEnergy));
    this.setUniform('u_mid', clamp(midEnergy));
    this.setUniform('u_high', clamp(highEnergy));

    // Pass full spectrum as array (first 32 frequency bins for performance)
    const spectrumData = Array.from(audioData.frequencyData.slice(0, 32)).map(v => clamp(v / 255));
    this.setUniform('u_spectrum', spectrumData);
  }

  /**
   * Get energy for a specific frequency band
   */
  private getFrequencyBandEnergy(frequencyData: Uint8Array, startRatio: number, endRatio: number): number {
    const start = Math.floor(frequencyData.length * startRatio);
    const end = Math.floor(frequencyData.length * endRatio);

    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += frequencyData[i];
    }

    return (sum / (end - start)) / 255;
  }

  /**
   * Get the canvas element
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    console.log('[GLSLRenderer] Destroy called');
    window.removeEventListener('resize', () => this.resizeCanvas());
    if (this.sandbox) {
      console.log('[GLSLRenderer] Destroying sandbox');
      this.sandbox.destroy();
      this.sandbox = null;
    }
    console.log('[GLSLRenderer] Destroy complete');
  }
}
