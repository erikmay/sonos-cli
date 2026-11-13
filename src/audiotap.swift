// Writes the sound of one app (or of all apps) as raw float32 PCM to stdout. The first stderr line is "format <rate> <channels>".
// Usage: audio-tap <bundle-id> | audio-tap --all
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

func log(_ message: String) {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func read<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = address(selector)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
  return value?.takeRetainedValue() as String?
}

func processObjects() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &list) == noErr else { return [] }
  return list
}

// Helper processes of an app have bundle IDs below the app's own ID.
func processes(of bundleID: String) -> [AudioObjectID] {
  processObjects().filter { object in
    guard let id = readString(object, kAudioProcessPropertyBundleID) else { return false }
    return id == bundleID || id.hasPrefix(bundleID + ".")
  }
}

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 1, let target = arguments.first else { fail("Usage: audio-tap <bundle-id> | audio-tap --all") }

let description: CATapDescription
if target == "--all" {
  description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
} else {
  var found = processes(of: target)
  // An app appears in the process list only after it opens its audio output.
  if found.isEmpty { log("Waiting for \(target) to open its audio output ...") }
  while found.isEmpty {
    Thread.sleep(forTimeInterval: 1)
    found = processes(of: target)
  }
  description = CATapDescription(stereoMixdownOfProcesses: found)
}
description.uuid = UUID()
description.isPrivate = true
// The sound plays on Sonos only. Without this, the Mac plays it a few seconds ahead.
description.muteBehavior = .mutedWhenTapped

var tap = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(description, &tap), "Creating the audio tap")

guard let format = read(tap, kAudioTapPropertyFormat, AudioStreamBasicDescription()),
  format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32
else { fail("The audio tap has an unsupported format") }
let channels = Int(format.mChannelsPerFrame)
let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0

// The aggregate device needs a real output device as its clock.
guard let output = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(kAudioObjectUnknown)),
  let outputUID = readString(output, kAudioDevicePropertyDeviceUID)
else { fail("No audio output device found") }

let settings: [String: Any] = [
  kAudioAggregateDeviceNameKey: "sonos-cli audio tap",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
]
var device = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(settings as CFDictionary, &device), "Creating the aggregate device")

func cleanUp() {
  AudioHardwareDestroyAggregateDevice(device)
  AudioHardwareDestroyProcessTap(tap)
}

func writeAll(_ bytes: UnsafeRawPointer, _ count: Int) {
  var offset = 0
  while offset < count {
    let written = write(STDOUT_FILENO, bytes + offset, count - offset)
    if written < 0 {
      if errno == EINTR { continue }
      // The reader is gone, so the stream has ended.
      cleanUp()
      exit(0)
    }
    offset += written
  }
}

let started = Date()
var heardSound = false
var warnedSilence = false
var frames = [Float]()

var proc: AudioDeviceIOProcID?
check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, DispatchQueue(label: "audio-tap")) { _, input, _, _, _ in
  let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
  if interleaved || buffers.count == 1 {
    for buffer in buffers {
      guard let data = buffer.mData else { continue }
      if !heardSound {
        let samples = data.bindMemory(to: Float.self, capacity: Int(buffer.mDataByteSize) / 4)
        heardSound = (0..<Int(buffer.mDataByteSize) / 4).contains { samples[$0] != 0 }
      }
      writeAll(data, Int(buffer.mDataByteSize))
    }
  } else {
    let count = Int(buffers[0].mDataByteSize) / 4
    if frames.count != count * channels { frames = [Float](repeating: 0, count: count * channels) }
    for (c, buffer) in buffers.prefix(channels).enumerated() {
      guard let data = buffer.mData else { continue }
      let samples = data.bindMemory(to: Float.self, capacity: count)
      for i in 0..<count { frames[i * channels + c] = samples[i] }
    }
    if !heardSound { heardSound = frames.contains { $0 != 0 } }
    frames.withUnsafeBytes { writeAll($0.baseAddress!, $0.count) }
  }
  // Without the permission, macOS delivers silence and no error.
  if !heardSound && !warnedSilence && Date().timeIntervalSince(started) > 15 {
    warnedSilence = true
    log("Only silence so far. If music plays, allow \"System Audio Recording\" for your terminal in System Settings > Privacy & Security.")
  }
}, "Creating the audio callback")

for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler {
    AudioDeviceStop(device, proc)
    cleanUp()
    exit(0)
  }
  source.resume()
  // Keep the source alive for the life of the process.
  _ = Unmanaged.passRetained(source)
}

check(AudioDeviceStart(device, proc), "Starting the audio capture")
log("format \(Int(format.mSampleRate)) \(channels)")
dispatchMain()
