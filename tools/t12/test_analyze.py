#!/usr/bin/env python3
"""Local synthetic-fixture regression checks for T-12 analyzer. Not WebRTC test."""
from datetime import datetime,timezone,timedelta
from analyze import analyze
BASE=datetime(2026,11,26,12,0,tzinfo=timezone.utc)

def iso(sec):return (BASE+timedelta(seconds=sec)).isoformat().replace('+00:00','Z')

def fixture(n=2,source=30,viewer_fps=30,hidden=False,vanish=None,playback_fps=None):
    keys=['V'+str(i+1).zfill(2) for i in range(n)]
    events=[{'type':'phase_start','phaseId':'phase1','target':n,'viewerKeys':keys,'at':iso(0)},
            {'type':'phase_end','phaseId':'phase1','target':n,'at':iso(20)}]
    samples=[]
    for t in range(1,20):
        samples.append({'at':iso(t),'key':'Alice','framesEncoded':source*t,'connectionState':'connected','visibilityState':'hidden' if hidden else 'visible'})
        for k in keys:
            if k==vanish and t>=12:continue
            frames=viewer_fps*t
            samples.append({'at':iso(t),'key':k,'framesDecoded':frames,
                'framesReceived':frames,'packetsReceived':150*t,'packetsLost':0,'freezeCount':0,
                'playbackFrames':(viewer_fps if playback_fps is None else playback_fps)*t,'connectionState':'connected','visibilityState':'visible','codec':'video/VP8'})
    return {'schemaVersion':'t12-browser-1','events':events,'samples':samples}

cases=[('normal2','PASS',fixture()),('normal5','PASS',fixture(5)),('slow_viewers','FAIL',fixture(viewer_fps=8)),('decodes_but_frozen','FAIL',fixture(playback_fps=0)),
       ('slow_source','INCONCLUSIVE',fixture(source=6)),('hidden_source','INCONCLUSIVE',fixture(hidden=True)),
       ('missing_phase_end','INCONCLUSIVE', {**fixture(),'events':[fixture()['events'][0]]}),
       ('missing_samples','INCONCLUSIVE',fixture(vanish='V02'))]
for name,expected,data in cases:
    got,report=analyze(data)
    if got!=expected:
        print(report);raise AssertionError(f'{name}: expected {expected}, got {got}')
    print('ok',name,got)
print('8/8 analyzer regression cases passed (synthetic fixtures only)')
