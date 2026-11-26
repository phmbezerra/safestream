#!/usr/bin/env python3
"""Evaluate T-12 local real-VP8 fan-out phases from browser-generated JSON.

This measures real browser decoding, NOT server-only RTP fan-out capacity.
Experimental acceptance only: all viewers >=20 decoded FPS and >=70% of
publisher encoded FPS, all connected, sufficient visible foreground sampling.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import statistics
import sys

SCHEMA = 't12-browser-1'

def parse_time(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)

def load(path):
    content = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if content.get('schemaVersion') != SCHEMA:
        raise ValueError(f'Expected {SCHEMA}, got {content.get("schemaVersion")!r}')
    for kind in ('samples', 'events'):
        if not isinstance(content.get(kind), list):
            raise ValueError(f'Missing {kind} array')
    return content

def extract_rate(samples, key, start, end, counter):
    selected = sorted((s for s in samples if s.get('key') == key and
        start <= parse_time(s['at']) <= end), key=lambda s:s['at'])
    valid = [s for s in selected if type(s.get(counter)) in (int, float) and s[counter] >= 0]
    if len(valid) < 8:
        return None, 'fewer than eight valid samples'
    first, last = valid[0], valid[-1]
    duration = (parse_time(last['at']) - parse_time(first['at'])).total_seconds()
    if duration < 12:
        return None, f'only {duration:.1f}s sampled (minimum 12s)'
    data = [s[counter] for s in valid]
    if any(b < a for a, b in zip(data, data[1:])):
        return None, 'counter reset/decreased during phase'
    delta = data[-1] - data[0]
    return dict(rate=delta/duration, delta=delta, duration=duration, first=first,
       last=last, samples=valid, allSamples=selected), None

def delta_by(metric, counter):
    seq = [x.get(counter) for x in metric['samples']]
    seq = [x for x in seq if type(x) in (int, float)]
    return seq[-1]-seq[0] if len(seq) >= 2 and all(y>=x for x,y in zip(seq,seq[1:])) else None

def analyze(data):
    lines=['SafeStream T-12 | Real VP8 Fan-out — local/browser-co-located experiment',
       'Acceptance (exploratory): >=20 decoded fps per viewer AND >=70% of source encoded fps;',
       'playback >=15 fps and >=60% of decoded fps; connected, foreground, >=12s sampling.',
       'NO production capacity, latency, independent endpoint, WAN, or SFU-only scaling claims.', '']
    starts=[e for e in data['events'] if e.get('type')=='phase_start']
    ends={e.get('phaseId'):e for e in data['events'] if e.get('type')=='phase_end'}
    if not starts:
        return 'INCONCLUSIVE', '\n'.join(lines+['INCONCLUSIVE: no phase_start events. Click Measure stage and wait until it completes.'])
    overall='PASS'
    for start_event in starts:
        pid=start_event.get('phaseId')
        target=start_event.get('target')
        viewer_keys=start_event.get('viewerKeys')
        end_event=ends.get(pid)
        problems=[];missing=[];notes=[]
        lines.append(f'=== {pid} / target {target} viewers ===')
        if not end_event:
            lines.append('INCONCLUSIVE: matching phase_end missing')
            overall='INCONCLUSIVE' if overall=='PASS' else overall
            lines.append('')
            continue
        start=parse_time(start_event['at']);end=parse_time(end_event['at']);duration=(end-start).total_seconds()
        lines.append(f'UTC interval: {start.isoformat()} .. {end.isoformat()} ({duration:.2f}s)')
        if duration < 18 or duration > 35:
            missing.append('phase duration outside 18–35s (timer suspension or premature export)')
        if type(target) is not int or target not in [2,5,10,20]:
            missing.append('unexpected target count')
        if not isinstance(viewer_keys,list) or len(viewer_keys)!=target or len(set(viewer_keys)) != len(viewer_keys):
            missing.append('viewerKeys count/uniqueness mismatch')
            viewer_keys=[]
        # Exclude first/last second to avoid boundary/partial second mixing.
        window_start=start+timedelta(seconds=1)
        window_end=end-timedelta(seconds=1)
        source,reason=extract_rate(data['samples'],'Alice',window_start,window_end,'framesEncoded')
        if reason:missing.append('Alice encoded: '+reason)
        source_rate=source['rate'] if source else None
        if source:
            lines.append(f'Alice: encoded {source_rate:.2f} fps ({source["delta"]} frames / {source["duration"]:.2f}s)')
            if source_rate < 20:missing.append('Alice encoded under 20 fps (source too slow for meaningful throughput comparison)')
        all_metrics={'Alice':source}
        if source:
            source_connected=sum(s.get('connectionState')=='connected' for s in source['samples'])/len(source['samples'])
            if source_connected < .95:problems.append('Alice connection was not continuously connected')
        for key in viewer_keys:
            metric,reason=extract_rate(data['samples'],key,window_start,window_end,'framesDecoded')
            all_metrics[key]=metric
            if reason:
                missing.append(key+': '+reason)
                lines.append(f'{key}: INCONCLUSIVE ({reason})')
                continue
            valid=metric['samples']
            codec_vals=[s.get('codec') for s in valid if s.get('codec')]
            connected_ratio=sum(s.get('connectionState')=='connected' for s in valid)/len(valid)
            received=delta_by(metric,'packetsReceived');lost=delta_by(metric,'packetsLost');freezes=delta_by(metric,'freezeCount')
            playback=delta_by(metric,'playbackFrames')
            playback_metric,playback_reason=extract_rate(data['samples'],key,window_start,window_end,'playbackFrames')
            lines.append(f'{key}: decoded {metric["rate"]:.2f} fps ({metric["delta"]}/{metric["duration"]:.2f}s), '
                 f'playback {playback_metric["rate"]:.2f} fps' if playback_metric else
                 f'{key}: decoded {metric["rate"]:.2f} fps, playback INCONCLUSIVE ({playback_reason})')
            lines.append(f'    connected {connected_ratio:.0%}, packets +{received if received is not None else "n/a"}, '
                 f'loss +{lost if lost is not None else "n/a"}, freezes +{freezes if freezes is not None else "n/a"}, '
                 f'playback frames +{playback if playback is not None else "n/a"}')
            if playback_reason:
                missing.append(key+': video playback stats: '+playback_reason)
            elif playback_metric['rate'] < 15 or playback_metric['rate'] < 0.6*metric['rate']:
                problems.append(key+f' playback {playback_metric["rate"]:.2f} fps below 15 fps or 60% of decoded fps')
            if codec_vals and not all(c.lower()=='video/vp8' for c in codec_vals):
                problems.append(key+' codec not consistently VP8')
            if not codec_vals:
                missing.append(key+' codec unreported')
            if connected_ratio < 0.95:
                problems.append(key+' had connectionState != connected for >5% samples')
            if metric['rate'] < 20:
                problems.append(key+f' decoded {metric["rate"]:.2f}<20 fps')
            if source_rate and source_rate >= 20 and metric['rate'] < 0.70*source_rate:
                problems.append(key+' decoded below 70% of Alice encoded rate')
            if freezes and freezes > 1:
                notes.append(key+f' recorded +{freezes} freezes (investigate)')
            if lost and received and lost/(lost+received)>0.02:
                notes.append(key+' lost >2% of packets in local test (investigate)')
        for key,metric in all_metrics.items():
            if metric:
                valid=metric['samples'];hidden_ratio=sum(s.get('visibilityState')!='visible' for s in valid)/len(valid)
                if hidden_ratio > 0.05:
                    missing.append(key+f' tab hidden in {hidden_ratio:.0%} of samples (browser throttling invalidates stage)')
        if problems:
            for p in problems:lines.append('FAIL: '+p)
        if missing:
            for p in missing:lines.append('INCONCLUSIVE: '+p)
        for n in notes:lines.append('NOTE: '+n)
        outcome='FAIL' if problems else ('INCONCLUSIVE' if missing else 'PASS')
        if outcome=='FAIL':overall='FAIL'
        elif outcome=='INCONCLUSIVE' and overall=='PASS':overall='INCONCLUSIVE'
        lines.append('STAGE RESULT: '+outcome)
        lines.append('')
    lines.append('OVERALL RESULT: '+overall)
    lines.append('Caveats: browser and SFU share hardware; server-only CPU requires separate OS process samples; no network impairment tested.')
    return overall, '\n'.join(lines)

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('evidence',help='T-12 JSON exported from t12-lab.html')
    p.add_argument('--out',help='optional text result path')
    args=p.parse_args(argv)
    try:result,report=analyze(load(args.evidence))
    except (ValueError,KeyError,TypeError,OSError) as e:
        print('INCONCLUSIVE: '+str(e),file=sys.stderr);return 2
    print(report)
    if args.out:
        out=Path(args.out);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(report+'\n',encoding='utf-8')
    return {'PASS':0,'FAIL':1,'INCONCLUSIVE':2}[result]

if __name__=='__main__':
    sys.exit(main())
