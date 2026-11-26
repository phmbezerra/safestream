#!/usr/bin/env python3
"""Read the user-exported T-11A viewer evidence. No external calls or writes."""
from pathlib import Path
import json
import sys

def assess(data):
    errors=[]
    if data.get('schemaVersion') != 't11-browser-1':
        errors.append('Expected schemaVersion t11-browser-1')
    if data.get('role')!='viewer':
        errors.append('Expected viewer evidence from Bob')
    viewer=[s for s in data.get('samples',[]) if s.get('role')=='viewer' and s.get('connectionState')=='connected']
    if len(viewer)<3:
        errors.append('Fewer than three connected viewer samples')
    elapsed=0.0;delta_frames=0;delta_packets=0;dimensions=False;codec=None
    if len(viewer)>=2:
        a,b=viewer[0],viewer[-1]
        elapsed=(float(b.get('performanceMs') or 0)-float(a.get('performanceMs') or 0))/1000
        delta_frames=int(b.get('framesDecoded') or 0)-int(a.get('framesDecoded') or 0)
        delta_packets=int(b.get('packetsReceived') or 0)-int(a.get('packetsReceived') or 0)
        dimensions=any((s.get('videoWidth') or 0)>0 and (s.get('videoHeight') or 0)>0 for s in viewer)
        codec=next((s['codecMimeType'] for s in viewer if s.get('codecMimeType')),None)
    if elapsed<5: errors.append(f'Observed connected duration <5 sec ({elapsed:.2f})')
    if delta_frames<=0: errors.append('No increase in decoded frames')
    if delta_packets<=0: errors.append('No increase in received RTP packets')
    if not dimensions: errors.append('No nonzero video element dimensions')
    if codec and codec.lower()!='video/vp8': errors.append('Unexpected inbound codec '+codec)
    return {'result':'PASS (local browser decode baseline)' if not errors else 'INCOMPLETE',
            'connectedSamples':len(viewer),'connectedSeconds':round(elapsed,2),
            'framesDecodedDelta':delta_frames,'packetsReceivedDelta':delta_packets,
            'averageDecodedFps':round(delta_frames/elapsed,2) if elapsed>0 else None,
            'remoteVideoDimensionsObserved':dimensions,'codecMimeType':codec,
            'caveats':['Browser telemetry is not glass-to-glass latency or verified presentation of each frame.',
                       'Single-host baseline only; watch the live video to verify smooth motion.'],
            'issues':errors}

def main():
    if len(sys.argv)!=2:
        raise SystemExit('Usage: py tools/t11a/analyze.py path-to-t11-viewer-evidence.json')
    path=Path(sys.argv[1])
    if not path.is_file(): raise SystemExit('ERROR: file not found')
    if path.stat().st_size>8*1024*1024: raise SystemExit('ERROR: evidence file too large')
    data=json.loads(path.read_text(encoding='utf-8-sig'))
    print(json.dumps(assess(data),indent=2,ensure_ascii=False))
    return 0 if assess(data)['result'].startswith('PASS') else 1

if __name__=='__main__': raise SystemExit(main())
