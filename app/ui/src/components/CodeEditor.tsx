import { useEffect, useRef, useMemo } from 'react';
import './CodeEditor.css';

interface CodeEditorProps {
  code: string;
  isVisible: boolean;
}

// GLSL syntax highlighting
function highlightGLSL(code: string): string {
  const keywords = /\b(void|float|vec2|vec3|vec4|mat2|mat3|mat4|int|bool|uniform|const|if|else|for|while|return|break|continue|discard|struct|in|out|inout|attribute|varying|precision|highp|mediump|lowp)\b/g;
  const types = /\b(sampler2D|samplerCube|gl_FragColor|gl_FragCoord|gl_Position)\b/g;
  const functions = /\b(sin|cos|tan|asin|acos|atan|pow|exp|log|exp2|log2|sqrt|inversesqrt|abs|sign|floor|ceil|fract|mod|min|max|clamp|mix|step|smoothstep|length|distance|dot|cross|normalize|reflect|refract|texture2D|radians|degrees|tanh)\b/g;
  const numbers = /\b(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\b/g;
  const preprocessor = /^(#.*)$/gm;
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;

  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(comments, '<span class="comment">$1</span>')
    .replace(preprocessor, '<span class="preprocessor">$1</span>')
    .replace(keywords, '<span class="keyword">$1</span>')
    .replace(types, '<span class="type">$1</span>')
    .replace(functions, '<span class="function">$1</span>')
    .replace(numbers, '<span class="number">$1</span>');
}

export function CodeEditor({ code, isVisible }: CodeEditorProps) {
  const codeRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => code.split('\n'), [code]);
  const highlightedLines = useMemo(() =>
    lines.map(line => highlightGLSL(line)),
    [lines]
  );

  // Auto-scroll to bottom when code updates
  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight;
    }
  }, [code]);

  // Sync line numbers scroll with code scroll
  const handleScroll = (e: React.UIEvent<HTMLPreElement>) => {
    if (linesRef.current) {
      linesRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  if (!isVisible) return null;

  return (
    <div className="code-editor-overlay">
      <div className="code-editor-container">
        <div className="code-editor-header">
          <span className="code-editor-title">Generating GLSL Shader...</span>
          <div className="code-editor-spinner"></div>
        </div>
        <div className="code-editor-content">
          <div className="code-editor-lines" ref={linesRef}>
            {lines.map((_, index) => (
              <div key={index} className="line-number">{index + 1}</div>
            ))}
          </div>
          <pre
            className="code-editor-code"
            ref={codeRef}
            onScroll={handleScroll}
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
          >
            {highlightedLines.map((line, index) => (
              <div key={index} className="code-line" dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }} />
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
