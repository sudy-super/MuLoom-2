/**
 * GLSL Generator Module
 * Converts audio analysis data to GLSL shader code using various LLM providers
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

export type ModelProvider = 'gemini' | 'openai';

export interface GLSLGenerationOptions {
  apiKey: string;
  audioFile?: File;
  prompt?: string;
  modelProvider?: ModelProvider;
  model?: string;
}

export class GLSLGenerator {
  private genAI?: GoogleGenerativeAI;
  private openAI?: OpenAI;
  private geminiModel?: any;
  private modelProvider: ModelProvider;
  private model: string;
  private listeners: Set<(glslCode: string) => void> = new Set();
  private progressListeners: Set<(progress: { code: string; isComplete: boolean }) => void> = new Set();
  private isGenerating: boolean = false;
  private audioFile?: File;
  private prompt?: string;
  private previousShader: string = '';

  constructor(options: GLSLGenerationOptions) {
    this.modelProvider = options.modelProvider || 'gemini';
    this.audioFile = options.audioFile;
    this.prompt = options.prompt;

    if (this.modelProvider === 'openai') {
      this.model = options.model || 'gpt-40';
      this.openAI = new OpenAI({
        apiKey: options.apiKey,
        dangerouslyAllowBrowser: true, // Note: In production, use a backend proxy
      });
    } else {
      this.model = options.model || 'gemini-2.5-flash';
      this.genAI = new GoogleGenerativeAI(options.apiKey);
      this.geminiModel = this.genAI.getGenerativeModel({
        model: this.model,
      });
    }
  }

  /**
   * Generate GLSL shader code (with audio file or prompt only)
   */
  async generateGLSL(): Promise<void> {
    if (this.isGenerating) {
      return;
    }

    this.isGenerating = true;

    console.log(`[GLSLGenerator] Starting GLSL generation with ${this.modelProvider}...`);

    try {
      if (this.modelProvider === 'openai') {
        await this.generateWithOpenAI();
      } else {
        await this.generateWithGemini();
      }
    } catch (error) {
      console.error('[GLSLGenerator] Failed to generate GLSL:', error);
      console.error('[GLSLGenerator] Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Use default shader on error
      this.notifyListeners(this.getDefaultShader());
    } finally {
      this.isGenerating = false;
      console.log('[GLSLGenerator] GLSL generation complete');
    }
  }

  /**
   * Generate GLSL using OpenAI API
   */
  private async generateWithOpenAI(): Promise<void> {
    if (!this.openAI) {
      throw new Error('OpenAI client not initialized');
    }

    const promptText = this.getPromptText();

    console.log('[GLSLGenerator] Calling OpenAI API with streaming...');

    // OpenAI doesn't support audio file analysis for shader generation in the same way
    // For microphone mode, we only use text prompts
    const stream = await this.openAI.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: promptText,
        },
      ],
      stream: true,
    });

    console.log('[GLSLGenerator] Stream started from OpenAI');

    let accumulatedCode = '';

    // Process streaming chunks
    for await (const chunk of stream) {
      const chunkText = chunk.choices[0]?.delta?.content || '';
      if (chunkText) {
        accumulatedCode += chunkText;
        console.log('[GLSLGenerator] Accumulated code length:', accumulatedCode.length);

        // Notify progress listeners with streaming code
        this.notifyProgressListeners(accumulatedCode, false);
      }
    }

    console.log('[GLSLGenerator] Stream complete');
    console.log('[GLSLGenerator] Final code length:', accumulatedCode.length);

    // Validate and process the shader code
    const processedShader = this.processShaderCode(accumulatedCode);
    console.log('[GLSLGenerator] Shader processed, notifying listeners');

    // Save as previous shader for potential rollback
    this.previousShader = processedShader;

    // Notify that generation is complete
    this.notifyProgressListeners(processedShader, true);
    this.notifyListeners(processedShader);
  }

  /**
   * Generate GLSL using Gemini API
   */
  private async generateWithGemini(): Promise<void> {
    if (!this.geminiModel) {
      throw new Error('Gemini model not initialized');
    }

    let parts: any[] = [];
    let promptText: string;

    // Mode 1: Audio file mode (only supported by Gemini)
    if (this.audioFile) {
      console.log('[GLSLGenerator] Converting audio file to base64...');
      const audioBase64 = await this.fileToBase64(this.audioFile);

      parts.push({
        inlineData: {
          mimeType: this.audioFile.type,
          data: audioBase64,
        },
      });

      promptText = this.getAudioFilePrompt();
    } else {
      // Mode 2: Prompt only mode (for microphone input)
      promptText = this.getPromptText();
    }

    parts.push({ text: promptText });

    console.log('[GLSLGenerator] Calling Gemini API with streaming...');

    // Call the model with streaming enabled
    const result = await this.geminiModel.generateContentStream({
      contents: [{
        role: 'user',
        parts: parts,
      }],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      } as any,
    });

    console.log('[GLSLGenerator] Stream started from Gemini');

    let accumulatedCode = '';

    // Process streaming chunks
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) {
        accumulatedCode += chunkText;
        console.log('[GLSLGenerator] Accumulated code length:', accumulatedCode.length);

        // Notify progress listeners with streaming code
        this.notifyProgressListeners(accumulatedCode, false);
      }
    }

    console.log('[GLSLGenerator] Stream complete');
    console.log('[GLSLGenerator] Final code length:', accumulatedCode.length);

    // Validate and process the shader code
    const processedShader = this.processShaderCode(accumulatedCode);
    console.log('[GLSLGenerator] Shader processed, notifying listeners');

    // Save as previous shader for potential rollback
    this.previousShader = processedShader;

    // Notify that generation is complete
    this.notifyProgressListeners(processedShader, true);
    this.notifyListeners(processedShader);
  }

  /**
   * Get prompt text for microphone/text-only mode
   */
  private getPromptText(): string {
    return `以下のプロンプトに基づいて、リアルタイムでオーディオに反応する視覚的に美しいGLSLフラグメントシェーダーを作成してください。

ユーザーのプロンプト: "${this.prompt || 'colorful and dynamic visual effect'}"

デザインガイドライン:
- ダイナミックで音楽に反応するビジュアルを作成
- 音楽の雰囲気、エネルギー、リズムに反応するビジュアルにする
- VJなので綺麗で輝いてる感じを中心にして

利用可能なオーディオUniform（リアルタイムで更新）:
- uniform float u_volume; // 全体の音量 (0.0 to 1.0)
- uniform float u_bass; // 低周波数エネルギー (0.0 to 1.0)
- uniform float u_mid; // 中周波数エネルギー (0.0 to 1.0)
- uniform float u_high; // 高周波数エネルギー (0.0 to 1.0)
- uniform float u_spectrum[32]; // 完全なスペクトルデータ配列 (各ビンで0.0 to 1.0)

標準Uniform:
- uniform vec2 u_resolution; // 画面解像度
- uniform float u_time; // アニメーション時間

技術要件:
- オーディオuniformを使用してビジュアルを音楽に反応させる
- texture2Dやテクスチャサンプリングは使用しない
- 外部関数やサンプラーは使用しない
- GLSLの組み込み数学関数のみを使用
- 完全で有効なGLSLフラグメントシェーダーコード
- forループのインデックスは必ず定数で初期化すること（例: for(int i=0; i<10; i++)）
- ループの範囲も定数にすること（変数による動的なループ範囲は不可）

できる限り画面を埋め尽くすようにし、動きや色の変化を豊かにしてください。

**重要: GLSLコードのみを出力してください。マークダウンのコードブロック(\`\`\`glsl)や説明文は一切含めないでください。シェーダーコードそのものだけを生成してください。**`;
  }

  /**
   * Get prompt text for audio file mode (Gemini only)
   */
  private getAudioFilePrompt(): string {
    return `この音声ファイルを分析して、音楽にリアルタイムで反応する視覚的に美しいGLSLフラグメントシェーダーを作成してください。

デザインガイドライン:
- ダイナミックで音楽に反応するビジュアルを作成
- 音楽の雰囲気、エネルギー、リズムに反応するビジュアルにする
- 音楽全体の雰囲気を考慮する
- VJなので綺麗で輝いてる感じを中心にして

利用可能なオーディオUniform（リアルタイムで更新）:
- uniform float u_volume; // 全体の音量 (0.0 to 1.0)
- uniform float u_bass; // 低周波数エネルギー (0.0 to 1.0)
- uniform float u_mid; // 中周波数エネルギー (0.0 to 1.0)
- uniform float u_high; // 高周波数エネルギー (0.0 to 1.0)
- uniform float u_spectrum[32]; // 完全なスペクトルデータ配列 (各ビンで0.0 to 1.0)

標準Uniform:
- uniform vec2 u_resolution; // 画面解像度
- uniform float u_time; // アニメーション時間

技術要件:
- オーディオuniformを使用してビジュアルを音楽に反応させる
- texture2Dやテクスチャサンプリングは使用しない
- 外部関数やサンプラーは使用しない
- GLSLの組み込み数学関数のみを使用
- 完全で有効なGLSLフラグメントシェーダーコード
- forループのインデックスは必ず定数で初期化すること（例: for(int i=0; i<10; i++)）
- ループの範囲も定数にすること（変数による動的なループ範囲は不可）

以下のような高品質なフラクタル＋アンチエイリアシングのコードを参考にしてください:

\`\`\`glsl
#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_volume;
uniform float u_bass;

mat2 rot(float a) {
    a = radians(a);
    float s = sin(a), c = cos(a);
    return mat2(c, s, -s, c);
}

vec3 fractal(vec2 p) {
    float a = smoothstep(-0.1, 0.1, sin(u_time * 0.5));
    p *= rot(90.0 * a);
    vec2 p2 = p;
    p *= 0.5 + asin(0.9 * sin(u_time * 0.2)) * 0.3;
    p.y -= a;
    p.x += u_time * 0.3 + u_bass * 0.1;
    p = fract(p * 0.5);
    float m = 1000.0;
    float it = 0.0;
    for (int i = 0; i < 10; i++) {
        p = abs(p) / clamp(abs(p.x * p.y), 0.25, 2.0) - 1.0;
        float l = abs(p.x);
        m = min(m, l);
        if (m == l) {
            it = float(i);
        }
    }
    float f = smoothstep(0.015, 0.01, m * 0.5);
    f *= step(p2.y * 0.5 + p2.x + it * 0.1 - 0.3, 0.0);
    vec3 col = normalize(vec3(1.0, 0.0, 0.5));
    col.rg *= rot(length(p2 + it * 0.5) * 200.0);
    col = normalize(col + 0.5) + step(0.5, fract(p2.y * 100.0));
    return col * (f * 0.9 + 0.1) * (1.0 + u_volume * 5.0);
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy - 0.5;
    uv.x *= u_resolution.x / u_resolution.y;
    uv *= 1.0 + u_volume * 0.5;

    int aa = 5;
    float f = max(abs(uv.x), abs(uv.y));
    vec2 pixelSize = 10.0 / u_resolution.xy / float(aa) * f;
    vec3 col = vec3(0.0);

    for (int i = -aa; i <= aa; i++) {
        for (int j = -aa; j <= aa; j++) {
            vec2 offset = vec2(float(i), float(j)) * pixelSize;
            col += fractal(uv + offset);
        }
    }

    float totalSamples = float((aa * 2 + 1) * (aa * 2 + 1));
    col /= totalSamples;
    col *= exp(-1.0 * f);

    gl_FragColor = vec4(col, 1.0);
}
\`\`\`

レイマーチングを使った波形ビジュアライゼーションの例:

\`\`\`glsl
#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_spectrum[32];

void main() {
    vec2 I = gl_FragCoord.xy;
    vec4 O = vec4(0.0);

    float i, d, z, r;

    // Raymarch 90 steps
    for(float step = 0.0; step < 90.0; step++) {
        // Raymarch sample point
        vec3 R = vec3(u_resolution.xy, u_resolution.y);
        vec3 p = z * normalize(vec3(I + I, 0.0) * 1.0 - R * 1.1);

        // Shift camera and get reflection coordinates
        p.y += 1.0;
        r = max(-p.y, 0.0) * 1.0;

        // Get spectrum index from x position
        float specIndex = clamp((p.x + 6.5) / 15.0, 0.0, 1.0);
        int idx = int(specIndex * 31.0);
        float specValue = u_spectrum[idx];

        // Mirror and music reaction
        p.y += r + r - 4.0 * specValue;

        // Step forward (reflections are softer)
        float dz = p.z + 3.0;
        d = 0.1 * (0.1 * r + abs(p.y) / (1.0 + r + r + r * r) + max(dz, -dz * 0.1));
        z += d;

        // Pick color and attenuate
        O += (cos(z * 0.5 + u_time * 0.6 + vec4(0, 2, 4, 3)) + 1.3) / d / z;
    }

    // Tanh tonemapping
    O = tanh(O / 900.0);
    gl_FragColor = O;
}
\`\`\`

このコードスタイルを参考に、音楽に合った独自のビジュアルを生成してください。
できる限り画面を埋め尽くすようにし、動きや色の変化を豊かにしてください。

**重要: GLSLコードのみを出力してください。マークダウンのコードブロック(\`\`\`glsl)や説明文は一切含めないでください。シェーダーコードそのものだけを生成してください。**`;
  }

  /**
   * Convert File to base64 string
   */
  private async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:audio/mpeg;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Process and validate shader code
   */
  private processShaderCode(code: string): string {
    // Remove any markdown code blocks if present
    let processedCode = code.replace(/```glsl\n?/g, '').replace(/```\n?/g, '');

    // Ensure we have basic shader structure
    if (!processedCode.includes('void main()')) {
      console.warn('Invalid shader: missing main function');
      return this.getDefaultShader();
    }

    // Add precision if missing
    if (!processedCode.includes('precision')) {
      processedCode = `#ifdef GL_ES
precision mediump float;
#endif

` + processedCode;
    }

    return processedCode.trim();
  }

  /**
   * Get default shader as fallback
   */
  private getDefaultShader(): string {
    return `precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

void main() {
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    vec3 color = vec3(st.x, st.y, abs(sin(u_time)));
    gl_FragColor = vec4(color, 1.0);
}`;
  }

  /**
   * Get error display shader
   */
  private getErrorShader(): string {
    return `#ifdef GL_ES
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    uv = uv * 2.0 - 1.0;
    uv.x *= u_resolution.x / u_resolution.y;

    // Pulsating red background
    float pulse = 0.5 + 0.5 * sin(u_time * 3.0);
    vec3 bgColor = vec3(0.3 + pulse * 0.2, 0.0, 0.0);

    // Simple "ERROR" text representation using distance fields
    float dist = 1.0;

    // E
    float e1 = step(abs(uv.x + 0.6), 0.15) * step(abs(uv.y), 0.3);
    float e2 = step(abs(uv.y), 0.05) * step(abs(uv.x + 0.6), 0.15);
    float e3 = step(abs(uv.y - 0.25), 0.05) * step(abs(uv.x + 0.525), 0.075);
    float e4 = step(abs(uv.y + 0.25), 0.05) * step(abs(uv.x + 0.525), 0.075);
    float e = max(max(e2, e3), e4);

    // R (simplified)
    float r1 = step(abs(uv.x + 0.25), 0.15) * step(abs(uv.y), 0.3);
    float r2 = step(abs(uv.y + 0.15), 0.15) * step(abs(uv.x + 0.25), 0.15);
    float r = max(r1, r2);

    // Display text
    float text = max(e, r);
    vec3 textColor = vec3(1.0, 0.2, 0.2) * (1.0 + pulse * 0.5);

    vec3 color = mix(bgColor, textColor, text);
    gl_FragColor = vec4(color, 1.0);
}`;
  }

  /**
   * Rollback to previous shader on error
   */
  async rollbackToPreviousShader(): Promise<void> {
    if (this.previousShader) {
      console.log('[GLSLGenerator] Rolling back to previous shader');

      // Show error shader briefly
      const errorShader = this.getErrorShader();
      this.notifyListeners(errorShader);

      // Wait for 1.5 seconds
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Restore previous shader
      this.notifyListeners(this.previousShader);
    } else {
      console.log('[GLSLGenerator] No previous shader to rollback to, using default');
      this.notifyListeners(this.getDefaultShader());
    }
  }

  /**
   * Subscribe to GLSL code updates
   */
  subscribe(callback: (glslCode: string) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Subscribe to code generation progress
   */
  subscribeProgress(callback: (progress: { code: string; isComplete: boolean }) => void): () => void {
    this.progressListeners.add(callback);
    return () => this.progressListeners.delete(callback);
  }

  /**
   * Notify all listeners
   */
  private notifyListeners(glslCode: string): void {
    this.listeners.forEach(listener => listener(glslCode));
  }

  /**
   * Notify progress listeners
   */
  private notifyProgressListeners(code: string, isComplete: boolean): void {
    this.progressListeners.forEach(listener => listener({ code, isComplete }));
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.listeners.clear();
    this.progressListeners.clear();
  }
}
