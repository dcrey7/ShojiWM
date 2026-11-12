"""Ask the GPU driver for a HIGH priority EGL context (like ShojiWM) and print what it grants.

Uses the same path as ShojiWM's tty backend: a GBM device on the DRM render
node, an EGL display on it, and EGL_IMG_context_priority.

  python3 tools/debug/egl-priority-check.py [/dev/dri/renderD128]
"""

import ctypes
import os
import sys

EGL_PLATFORM_GBM_KHR = 0x31D7
EGL_CONTEXT_PRIORITY_LEVEL_IMG = 0x3100
NAMES = {0x3101: "HIGH", 0x3102: "MEDIUM", 0x3103: "LOW"}
EGL_CONTEXT_CLIENT_VERSION = 0x3098
EGL_NONE = 0x3038
EGL_OPENGL_ES_API = 0x30A0
EGL_NO_CONFIG = None

node = sys.argv[1] if len(sys.argv) > 1 else "/dev/dri/renderD128"
egl = ctypes.CDLL("libEGL.so.1")
gbm = ctypes.CDLL("libgbm.so.1")

gbm.gbm_create_device.restype = ctypes.c_void_p
gbm.gbm_create_device.argtypes = [ctypes.c_int]
egl.eglGetPlatformDisplay.restype = ctypes.c_void_p
egl.eglGetPlatformDisplay.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
egl.eglInitialize.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
egl.eglQueryString.restype = ctypes.c_char_p
egl.eglQueryString.argtypes = [ctypes.c_void_p, ctypes.c_int]
egl.eglCreateContext.restype = ctypes.c_void_p
egl.eglCreateContext.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
egl.eglQueryContext.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]

fd = os.open(node, os.O_RDWR)
device = gbm.gbm_create_device(fd)
display = egl.eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, device, None)
if not display or not egl.eglInitialize(display, None, None):
    sys.exit("EGL init failed")
print("vendor:", egl.eglQueryString(display, 0x3053).decode())  # EGL_VENDOR
egl.eglBindAPI(EGL_OPENGL_ES_API)
attribs = (ctypes.c_int * 5)(EGL_CONTEXT_CLIENT_VERSION, 2, EGL_CONTEXT_PRIORITY_LEVEL_IMG, 0x3101, EGL_NONE)
context = egl.eglCreateContext(display, EGL_NO_CONFIG, None, attribs)
if not context:
    sys.exit(f"eglCreateContext failed: 0x{egl.eglGetError():x}")
got = ctypes.c_int(0)
egl.eglQueryContext(display, context, EGL_CONTEXT_PRIORITY_LEVEL_IMG, ctypes.byref(got))
print("asked: HIGH  got:", NAMES.get(got.value, hex(got.value)))
