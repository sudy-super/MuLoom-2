source .venv/bin/activate

bash scripts/env.d/gstreamer_env.sh

BREW_PREFIX="$(brew --prefix)"                                      
export GI_TYPELIB_PATH="$BREW_PREFIX/lib/girepository-1.0:${GI_TYPELIB_PATH}"
export DYLD_FALLBACK_LIBRARY_PATH="$BREW_PREFIX/opt/glib/lib:$BREW_PREFIX/lib:${DYLD_FALLBACK_LIBRARY_PATH}"
export GST_PLUGIN_SCANNER="$BREW_PREFIX/opt/gstreamer/libexec/gstreamer-1.0/gst-plugin-scanner"
export PATH="$BREW_PREFIX/opt/gstreamer/bin:$PATH"

export GST_PLUGIN_FEATURE_RANK="gtksink:NONE,gtk4paintablesink:NONE"

ls "$BREW_PREFIX/lib/girepository-1.0/glib-2.0.typelib"
ls "$BREW_PREFIX/opt/glib/lib/libglib-2.0.0.dylib" "$BREW_PREFIX/opt/glib/lib/libgobject-2.0.0.dylib"
which gst-plugin-scanner || echo "$GST_PLUGIN_SCANNER"
gst-inspect-1.0 avfvideosrc >/dev/null && echo "OK: avfvideosrc found"
