#!/usr/bin/env bash
#
# Configure environment variables so Homebrew-installed GStreamer/PyGObject
# libraries are discoverable from Python.
# ソースして利用してください:
#   source scripts/env.d/gstreamer_env.sh

if ! command -v brew >/dev/null 2>&1; then
  echo "gstreamer_env: Homebrew が見つかりません。先に Homebrew をインストールしてください。" >&2
  return 1 2>/dev/null || exit 1
fi

# prepend_path <ENV_VAR> <directory>
prepend_path() {
  local var="$1"
  local value="$2"
  if [[ -z "$value" || ! -d "$value" ]]; then
    return
  fi
  local current
  current="$(eval "printf '%s' \"\${$var-}\"")"
  if [[ ":$current:" == *":$value:"* ]]; then
    return
  fi
  if [[ -n "$current" ]]; then
    eval "export $var=\"$value:$current\""
  else
    eval "export $var=\"$value\""
  fi
}

export HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-$(brew --prefix)}"

gst_prefix="$(brew --prefix gstreamer 2>/dev/null || true)"
glib_prefix="$(brew --prefix glib 2>/dev/null || true)"
gi_prefix="$(brew --prefix gobject-introspection 2>/dev/null || true)"
gtk3_prefix="$(brew --prefix gtk+3 2>/dev/null || true)"
gtk4_prefix="$(brew --prefix gtk4 2>/dev/null || true)"
gst_plugins_bad_prefix="$(brew --prefix gst-plugins-bad 2>/dev/null || true)"
gstreamer_opt_prefix="$HOMEBREW_PREFIX/opt/gstreamer"
glib_opt_prefix="$HOMEBREW_PREFIX/opt/glib"

missing_formulas=()
for formula in gstreamer glib gobject-introspection; do
  if ! brew list --versions "$formula" >/dev/null 2>&1; then
    missing_formulas+=("$formula")
  fi
done

# Typelib 検索パス
prepend_path GI_TYPELIB_PATH "$HOMEBREW_PREFIX/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gstreamer_opt_prefix/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gst_prefix/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gi_prefix/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gtk3_prefix/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gtk4_prefix/lib/girepository-1.0"
prepend_path GI_TYPELIB_PATH "$gst_plugins_bad_prefix/lib/girepository-1.0"

# GLib/GObject のライブラリを解決できるようにする
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$HOMEBREW_PREFIX/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$gstreamer_opt_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$glib_opt_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$gst_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$glib_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$gtk3_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$gtk4_prefix/lib"
prepend_path DYLD_FALLBACK_LIBRARY_PATH "$gst_plugins_bad_prefix/lib"

# GIO モジュール (ファイルシステム監視等で利用される)
prepend_path GIO_EXTRA_MODULES "$HOMEBREW_PREFIX/lib/gio/modules"
prepend_path GIO_EXTRA_MODULES "$glib_prefix/lib/gio/modules"
prepend_path GIO_EXTRA_MODULES "$gtk3_prefix/lib/gio/modules"
prepend_path GIO_EXTRA_MODULES "$gtk4_prefix/lib/gio/modules"
prepend_path GIO_EXTRA_MODULES "$gst_plugins_bad_prefix/lib/gio/modules"

prepend_path GST_PLUGIN_SYSTEM_PATH_1_0 "$gstreamer_opt_prefix/lib/gstreamer-1.0"
prepend_path GST_PLUGIN_SYSTEM_PATH_1_0 "$gst_prefix/lib/gstreamer-1.0"
prepend_path GST_PLUGIN_SYSTEM_PATH_1_0 "$gst_plugins_bad_prefix/lib/gstreamer-1.0"
prepend_path GST_PLUGIN_PATH "$gstreamer_opt_prefix/lib/gstreamer-1.0"
prepend_path GST_PLUGIN_PATH "$gst_prefix/lib/gstreamer-1.0"
prepend_path GST_PLUGIN_PATH "$gst_plugins_bad_prefix/lib/gstreamer-1.0"

prepend_path PATH "$gstreamer_opt_prefix/bin"
prepend_path PATH "$gst_prefix/bin"

gst_scanner_opt="$gstreamer_opt_prefix/libexec/gstreamer-1.0/gst-plugin-scanner"
gst_scanner_cellar="$gst_prefix/libexec/gstreamer-1.0/gst-plugin-scanner"
if [[ -x "$gst_scanner_opt" ]]; then
  export GST_PLUGIN_SCANNER="$gst_scanner_opt"
elif [[ -x "$gst_scanner_cellar" ]]; then
  export GST_PLUGIN_SCANNER="$gst_scanner_cellar"
fi

export GST_PLUGIN_FEATURE_RANK="gtksink:NONE,gtk4paintablesink:NONE"

export GI_TYPELIB_PATH
export DYLD_FALLBACK_LIBRARY_PATH
export GIO_EXTRA_MODULES
export GST_PLUGIN_SYSTEM_PATH_1_0
export GST_PLUGIN_PATH

echo "gstreamer_env: 環境変数を設定しました。"
echo "  GI_TYPELIB_PATH=$GI_TYPELIB_PATH"
echo "  DYLD_FALLBACK_LIBRARY_PATH=$DYLD_FALLBACK_LIBRARY_PATH"
echo "  GIO_EXTRA_MODULES=$GIO_EXTRA_MODULES"
echo "  GST_PLUGIN_SYSTEM_PATH_1_0=$GST_PLUGIN_SYSTEM_PATH_1_0"
echo "  GST_PLUGIN_PATH=$GST_PLUGIN_PATH"
if [[ -n "${GST_PLUGIN_SCANNER-}" ]]; then
  echo "  GST_PLUGIN_SCANNER=$GST_PLUGIN_SCANNER"
fi
echo "  GST_PLUGIN_FEATURE_RANK=$GST_PLUGIN_FEATURE_RANK"

if [[ ${#missing_formulas[@]} -gt 0 ]]; then
  echo "gstreamer_env: 以下の Homebrew フォーミュラが見つかりませんでした。必要に応じてインストールしてください:" >&2
  printf '  - %s\n' "${missing_formulas[@]}" >&2
fi
