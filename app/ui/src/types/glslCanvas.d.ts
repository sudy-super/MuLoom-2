declare module 'glslCanvas' {
  export default class GlslCanvas {
    constructor(canvas: HTMLCanvasElement, options?: any);
    load(fragmentShader: string): void;
    setUniform(name: string, value: number | number[]): void;
    on(event: string, callback: Function): void;
    destroy(): void;
  }
}
