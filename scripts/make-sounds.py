import math
import struct
import sys
import wave
from pathlib import Path

RATE = 44100


def render(notes, length, gain=0.3):
    out = [0.0] * int(RATE * length)
    for freq, start, decay, overtones in notes:
        offset = int(RATE * start)
        for i in range(len(out) - offset):
            t = i / RATE
            envelope = min(1.0, t / 0.01) * math.exp(-t * decay)
            tone = sum(amp * math.sin(2 * math.pi * freq * mult * t) * math.exp(-t * decay * mult) for mult, amp in overtones)
            out[offset + i] += envelope * tone
    peak = max(abs(x) for x in out) or 1
    return b''.join(struct.pack('<h', int(x / peak * gain * 32767)) for x in out)


def pop():
    out = []
    for i in range(int(RATE * 0.25)):
        t = i / RATE
        freq = 420 + 900 * math.exp(-t * 40)
        out.append(math.sin(2 * math.pi * freq * t) * min(1.0, t / 0.003) * math.exp(-t * 22))
    peak = max(abs(x) for x in out)
    return b''.join(struct.pack('<h', int(x / peak * 0.35 * 32767)) for x in out)


SOUNDS = {
    'chime': lambda: render([(659.25, 0.0, 3.2, [(1, 1), (2, 0.25)]), (987.77, 0.16, 3.2, [(1, 1), (2, 0.25)])], 1.3),
    'bell': lambda: render([(880, 0.0, 3, [(1, 1), (2, 0.45), (3, 0.2), (4, 0.1)])], 1.2),
    'marimba': lambda: render([(523.25, 0.0, 9, [(1, 1), (4, 0.15)]), (659.25, 0.09, 9, [(1, 1), (4, 0.15)]), (783.99, 0.18, 7, [(1, 1), (4, 0.15)])], 0.9),
    'pop': pop,
}

folder = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent.parent / 'sounds')
for name, make in SOUNDS.items():
    with wave.open(str(folder / f'{name}.wav'), 'wb') as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(RATE)
        file.writeframes(make())
    print(folder / f'{name}.wav')
