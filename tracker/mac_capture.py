"""Native macOS capture by persistent device ID, avoiding OpenCV index ordering.

Frames are copied from a BGRA CVPixelBuffer into the existing BGR latest-frame
slot. AVFoundation discards late frames; each device has a separate serial queue.
"""

import time

import AVFoundation as av
import CoreMedia
import dispatch
from Foundation import NSObject
import numpy as np
import objc
import Quartz as cv

from tracker.capture import CameraCapture


class FrameDelegate(NSObject, protocols=[objc.protocolNamed('AVCaptureVideoDataOutputSampleBufferDelegate')]):
    owner = objc.ivar()

    def captureOutput_didOutputSampleBuffer_fromConnection_(self, output, sample, connection):
        owner = self.owner
        if owner is None or owner.stop_event.is_set():
            return
        pixel = None
        locked = False
        try:
            arrived_at = time.monotonic()
            pixel = CoreMedia.CMSampleBufferGetImageBuffer(sample)
            if pixel is None:
                return
            cv.CVPixelBufferLockBaseAddress(pixel, cv.kCVPixelBufferLock_ReadOnly)
            locked = True
            width, height = cv.CVPixelBufferGetWidth(pixel), cv.CVPixelBufferGetHeight(pixel)
            stride = cv.CVPixelBufferGetBytesPerRow(pixel)
            address = cv.CVPixelBufferGetBaseAddress(pixel)
            data = np.frombuffer(address.as_buffer(height * stride), dtype=np.uint8).reshape(height, stride)
            frame = data[:, :width * 4].reshape(height, width, 4)[..., :3].copy()
            owner.publish(frame, arrived_at)
        except Exception as exc:
            owner.error = exc
            owner.stop_event.set()
        finally:
            if locked:
                cv.CVPixelBufferUnlockBaseAddress(pixel, cv.kCVPixelBufferLock_ReadOnly)


class MacCameraCapture(CameraCapture):
    def __init__(self, uid, **kwargs):
        super().__init__(uid, **kwargs)
        self.uid = uid

    def publish(self, frame, observed_at):
        import cv2
        if self.rotation:
            frame = cv2.rotate(frame, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180,
                                      270: cv2.ROTATE_90_COUNTERCLOCKWISE}[self.rotation])
        self.count += 1
        self.frames.put((observed_at, frame))

    def _run(self):
        session = output = delegate = queue = None
        try:
            devices = av.AVCaptureDevice.devicesWithMediaType_(av.AVMediaTypeVideo)
            device = next((device for device in devices if str(device.uniqueID()) == self.uid), None)
            if device is None:
                raise RuntimeError(f'{self.role} camera {self.uid} disconnected; rerun camera_setup')
            input_device, error = av.AVCaptureDeviceInput.deviceInputWithDevice_error_(device, None)
            if input_device is None:
                raise RuntimeError(f'Cannot open {self.role}: {error}')
            session = av.AVCaptureSession.alloc().init()
            session.beginConfiguration()
            preset = av.AVCaptureSessionPreset1280x720 if self.size[0] >= 1280 else av.AVCaptureSessionPreset640x480
            if not session.canAddInput_(input_device):
                raise RuntimeError(f'Cannot add {self.role} camera input')
            session.addInput_(input_device)
            if session.canSetSessionPreset_(preset):
                session.setSessionPreset_(preset)
            output = av.AVCaptureVideoDataOutput.alloc().init()
            output.setVideoSettings_({cv.kCVPixelBufferPixelFormatTypeKey: cv.kCVPixelFormatType_32BGRA,
                                      cv.kCVPixelBufferWidthKey: self.size[0],
                                      cv.kCVPixelBufferHeightKey: self.size[1]})
            output.setAlwaysDiscardsLateVideoFrames_(True)
            delegate = FrameDelegate.alloc().init()
            delegate.owner = self
            queue = dispatch.dispatch_queue_create(f'mirror.capture.{self.role}'.encode(), None)
            output.setSampleBufferDelegate_queue_(delegate, queue)
            if not session.canAddOutput_(output):
                raise RuntimeError(f'Cannot add {self.role} camera output')
            session.addOutput_(output)
            if session.canSetSessionPreset_(preset):
                session.setSessionPreset_(preset)
            session.commitConfiguration()
            # Do not set activeFormat here: doing so can reset the session's preset.
            chosen = device.activeFormat()
            locked, error = device.lockForConfiguration_(None)
            if not locked:
                raise RuntimeError(f'Cannot configure {self.role}: {error}')
            try:
                ranges = chosen.videoSupportedFrameRateRanges()
                frame_range = min(ranges, key=lambda r: abs(max(r.minFrameRate(), min(self.fps, r.maxFrameRate())) - self.fps))
                fps = max(frame_range.minFrameRate(), min(self.fps, frame_range.maxFrameRate()))
                if fps == frame_range.maxFrameRate():
                    duration = frame_range.minFrameDuration()
                elif fps == frame_range.minFrameRate():
                    duration = frame_range.maxFrameDuration()
                else:
                    duration = CoreMedia.CMTimeMakeWithSeconds(1 / fps, 1_000_000_000)
                device.setActiveVideoMinFrameDuration_(duration)
                device.setActiveVideoMaxFrameDuration_(duration)
            finally:
                device.unlockForConfiguration()
            self.started_at = time.monotonic()
            session.startRunning()
            print(f'[{self.role}] native camera: {device.localizedName()} [{self.uid}] '
                  f'output {self.size} @ {fps:.1f} fps', flush=True)
            while not self.stop_event.wait(.1):
                _, captured = self.frames.get()
                stamp = captured[0] if captured else self.started_at
                if time.monotonic() - stamp > 5:
                    raise RuntimeError(f'{self.role} camera stopped delivering frames; check camera permissions or reconnect')
        except Exception as exc:
            self.error = exc
        finally:
            if output is not None:
                output.setSampleBufferDelegate_queue_(None, None)
            if session is not None:
                session.stopRunning()
            if delegate is not None:
                delegate.owner = None
