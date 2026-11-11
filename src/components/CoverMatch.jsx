import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import { Close, InfoOutlined, KeyboardArrowDown, PhotoCamera, Search } from '@mui/icons-material';
import { CAPTURE_INSET, createCaptureDetector, makeFrameSampler, matchesPedal, takeCoverPhoto } from '../cover-match/capture';
import { useCoverCamera } from '../cover-match/useCoverCamera';
import { soundFx } from '../utils/audio';

const pilotKey = 'fast_search_cover_pilot';
const pedalStorageKey = 'fast_search_cover_pedal';
const stateLabels = {
  calibrating: 'Calibrating the empty area', ready: 'Ready for the next book',
  detected: 'Book detected. Hold it still.',
  clear: 'Remove the previous book to rearm', reset: 'Clear the guide and select Calibrate empty area',
};
const matchLabels = {
  exact_isbn: 'Exact ISBN', edition_mapping: 'Known edition', edition_conflict: 'Edition conflict', title: 'Title match',
  cover_vector: 'Cover photo match', cover_suggestion: 'Cover suggestion',
};
const busyLabels = {
  search: 'Searching the Master…', confirm: 'Confirming the box…',
};
const searchLabels = {
  cover_vector: 'Vector search', photo_text: 'Gemini OCR', isbn_page: 'Gemini OCR · ISBN page', typed: 'Typed title or ISBN',
};
const vectorReasonLabels = {
  weak_cover: 'Verified covers scored below the similarity cutoff.', empty_cover_results: 'No verified covers were returned.',
  stale_cover_index: 'The cover result did not match the current Master.',
  vector_timeout: 'Vector search took too long.', vector_unavailable: 'Vector search was unavailable.',
  unsupported_cover_format: 'This photo format is unsupported by vector search.',
};

function savePilotObservation(id, observation) {
  if (!id) return;
  try {
    const entries = JSON.parse(localStorage.getItem(pilotKey) || '[]');
    const previous = entries.find(entry => entry.id === id);
    localStorage.setItem(pilotKey, JSON.stringify([...entries.filter(entry => entry.id !== id), { ...previous, ...observation, id }].slice(-100)));
  } catch { /* Pilot logging is optional and does not gate packing. */ }
}

function photoRequest(image, station, mode, verifyIsbn = false) {
  const body = new FormData();
  body.append('image', image, 'cover.jpg');
  const params = new URLSearchParams({ station, mode });
  if (verifyIsbn) params.set('verify', 'isbn');
  return [`/api/cover-match?${params}`, { body }];
}

function Candidates({ lookup, locked, onConfirm, onMoreInfo, onPreview }) {
  const [visibleCount, setVisibleCount] = useState(3);
  const gridRef = useRef(null);
  useEffect(() => { setVisibleCount(3); }, [lookup]);
  if (!lookup?.candidates.length) return null;
  const verifyTitles = lookup.reviewReasons.includes('verify_fallback_isbn');
  const visible = lookup.candidates.slice(0, visibleCount);
  const hasMore = lookup.candidates.length > visibleCount;
  return <Stack gap={1.25}>
    <Box ref={gridRef} sx={{
      display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5,
      ...(visibleCount > 3 ? { maxHeight: 780, overflowY: 'auto', pr: .5 } : {}),
    }}>
      {visible.map(candidate => {
        const isVector = ['cover_vector', 'cover_suggestion'].includes(candidate.matchType);
        return <Paper variant="outlined" key={`${candidate.isbn}-${candidate.order}`} sx={{
          p: 1.5, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 1.25,
        }}>
          <Stack gap={1} sx={{ minWidth: 0 }}>
            {(isVector || candidate.coverUrl) &&
              <VectorCoverThumbnail key={candidate.coverUrl} src={candidate.coverUrl} similarity={isVector ? candidate.score.toFixed(3) : undefined}
                onClick={candidate.coverUrl ? () => onPreview?.({ src: candidate.coverUrl, title: candidate.listingTitle || candidate.title || candidate.isbn }) : undefined} />}
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" gap={.75} justifyContent="space-between" alignItems="flex-start">
                <Typography sx={{ fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.3, flex: 1, overflowWrap: 'anywhere' }}>
                  {candidate.listingTitle || candidate.title || candidate.isbn}
                </Typography>
                <Tooltip title="More info">
                  <IconButton size="small" aria-label="More info" onClick={() => onMoreInfo?.(candidate)} sx={{ mt: -.25, color: 'text.secondary' }}>
                    <InfoOutlined fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: .5, overflowWrap: 'anywhere' }}>
                {[candidate.author, `PO ISBN ${candidate.isbn}`, !isVector && `${candidate.score} score`,
                  !verifyTitles && `${candidate.remaining} remaining`].filter(Boolean).join(' · ')}
              </Typography>
              <Stack direction="row" gap={.75} flexWrap="wrap" sx={{ mt: .75 }}>
                <Chip label={verifyTitles ? 'Verify ISBN' : candidate.alreadyPacked ? candidate.amazonIsbn ? 'Edition unavailable' : 'Already packed' : `Box ${candidate.order}`} color={candidate.confirmationToken ? 'primary' : 'default'} size="small" />
              </Stack>
            </Box>
          </Stack>
          {candidate.confirmationToken
            ? <Button fullWidth variant="contained" disabled={locked} onClick={() => onConfirm(candidate)} sx={{ minHeight: 40 }}>
              {candidate.matchType === 'cover_suggestion' ? 'Mark as packed' : `Confirm box ${candidate.order}`}
            </Button>
            : !verifyTitles && !candidate.amazonIsbn && !candidate.alreadyPacked && <Typography variant="body2" color="text.secondary">{candidate.matchType === 'edition_conflict' ? 'Verify the edition before packing.' : 'A different box takes the next copy.'}</Typography>}
        </Paper>;
      })}
    </Box>
    {hasMore && <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <Tooltip title="Show more results">
        <IconButton aria-label="Show more results" onClick={() => {
          setVisibleCount(count => count + 3);
          setTimeout(() => gridRef.current?.scrollBy({ top: 240, behavior: 'smooth' }), 50);
        }} sx={{ border: '1px solid rgba(255,255,255,.16)' }}>
          <KeyboardArrowDown />
        </IconButton>
      </Tooltip>
    </Box>}
    {lookup.candidateCount > lookup.candidates.length && <Typography variant="body2" color="text.secondary">Showing {lookup.candidates.length} of {lookup.candidateCount} choices. Use typed search to narrow the result.</Typography>}
  </Stack>;
}

function VectorCoverThumbnail({ src, similarity, onClick }) {
  const [failed, setFailed] = useState(false);
  const clickable = Boolean(src && !failed && onClick);
  return <Box
    onClick={clickable ? onClick : undefined}
    role={clickable ? 'button' : undefined}
    tabIndex={clickable ? 0 : undefined}
    onKeyDown={clickable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } } : undefined}
    sx={{
      position: 'relative', width: '100%', height: 280, p: .75, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden',
      cursor: clickable ? 'zoom-in' : 'default',
    }}>
    {similarity != null && <Box sx={{
      position: 'absolute', top: 8, right: 8, zIndex: 1,
      px: 1, py: .35, borderRadius: 1, fontSize: 12, fontWeight: 600,
      bgcolor: 'rgba(18, 18, 18, 0.84)', color: '#b9c8ff',
      border: '1px solid rgba(255, 255, 255, 0.16)', backdropFilter: 'blur(4px)',
    }}>
      {similarity} similarity
    </Box>}
    {src && !failed
      ? <Box component="img" src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        onError={() => setFailed(true)} sx={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain', display: 'block' }} />
      : <Typography variant="caption" color="text.secondary" align="center">Cover unavailable</Typography>}
  </Box>;
}

function VectorSuggestions({ suggestions, review = false, locked, onPack, onMoreInfo, onPreview }) {
  const [visibleCount, setVisibleCount] = useState(3);
  const gridRef = useRef(null);
  useEffect(() => { setVisibleCount(3); }, [suggestions]);
  if (!suggestions?.length) return null;
  const visible = suggestions.slice(0, visibleCount);
  const hasMore = suggestions.length > visibleCount;
  return <Box>
    <Typography component="h3" fontWeight={700} sx={{ mb: 1 }}>{review ? 'More cover matches to review' : 'Closest verified covers'}</Typography>
    <Box ref={gridRef} sx={{
      display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5,
      ...(visibleCount > 3 ? { maxHeight: 780, overflowY: 'auto', pr: .5 } : {}),
    }}>
      {visible.map(suggestion => {
        const { isbn, title, score, coverUrl, listingTitle, order, alreadyPacked, confirmationToken } = suggestion;
        return <Paper key={isbn} variant="outlined" sx={{
          p: 1.25, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 1.25,
        }}>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <VectorCoverThumbnail key={coverUrl} src={coverUrl} similarity={score.toFixed(3)}
              onClick={coverUrl ? () => onPreview?.({ src: coverUrl, title: listingTitle || title || isbn }) : undefined} />
            <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <Stack direction="row" gap={.5} justifyContent="space-between" alignItems="flex-start">
                <Typography sx={{ fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.3, flex: 1 }}>
                  {listingTitle || title || isbn}
                </Typography>
                <Tooltip title="More info">
                  <IconButton size="small" aria-label="More info" onClick={() => onMoreInfo?.({ ...suggestion, review })} sx={{ mt: -.25, color: 'text.secondary' }}>
                    <InfoOutlined fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: .4 }}>
                PO ISBN {isbn}
              </Typography>
              <Stack direction="row" gap={.75} flexWrap="wrap" sx={{ mt: .75 }}>
                {order && <Chip label={`Box ${order}`} size="small" />}
                {alreadyPacked && <Chip label="Already packed" size="small" />}
              </Stack>
            </Box>
          </Stack>
          {confirmationToken && <Button fullWidth variant="contained" disabled={locked} onClick={() => onPack(suggestion)} sx={{ minHeight: 40 }}>
            Mark as packed
          </Button>}
        </Paper>;
      })}
    </Box>
    {hasMore && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.25 }}>
      <Tooltip title="Show more results">
        <IconButton aria-label="Show more results" onClick={() => {
          setVisibleCount(count => count + 3);
          setTimeout(() => gridRef.current?.scrollBy({ top: 240, behavior: 'smooth' }), 50);
        }} sx={{ border: '1px solid rgba(255,255,255,.16)' }}>
          <KeyboardArrowDown />
        </IconButton>
      </Tooltip>
    </Box>}
  </Box>;
}

export default function CoverMatch({ manager, enabled, mode, onModeChange }) {
  const camera = useCoverCamera();
  const [auto, setAuto] = useState(true);
  const [pedal, setPedal] = useState(() => {
    try { return localStorage.getItem(pedalStorageKey) ?? 'F8'; } catch { return 'F8'; }
  });
  const [cameraState, setCameraState] = useState('calibrating');
  const [internalTab, setInternalTab] = useState('vector');
  const preferredTab = mode ?? internalTab;
  const setPreferredTab = value => {
    setInternalTab(value);
    onModeChange?.(value);
  };
  const [photoMode, setPhotoMode] = useState('ocr');
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState(null);
  const [packSuggestion, setPackSuggestion] = useState(null);
  const [infoItem, setInfoItem] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [packed, setPacked] = useState(() => manager.lastConfirmed?.source === 'cover' && !manager.pending ? manager.lastConfirmed : null);
  const [error, setError] = useState('');
  const [failedLookup, setFailedLookup] = useState(null);
  const [busy, setBusy] = useState(null);
  const [lastCapture, setLastCapture] = useState(null);
  const detector = useRef(null);
  const mounted = useRef(false);
  const guard = useRef(null);
  const activeLookup = useRef(null);
  const vectorPhoto = useRef(null);
  const actions = useRef(null);
  const pendingCover = Boolean(manager.pending?.confirmationToken);
  const locked = !enabled || !manager.connected || !manager.ready || manager.busy || Boolean(manager.pending) || Boolean(busy);
  const cameraLive = camera.status === 'live';
  const vector = manager.coverVector;
  const vectorAvailable = vector?.enabled && (!vector.pilotStation || vector.pilotStation === manager.station);
  const tab = vectorAvailable ? preferredTab : 'title';
  const resultSource = lookup ?? failedLookup;

  function showPack(scan) {
    vectorPhoto.current = null;
    setPacked(scan); setLookup(null); setQuery(''); setError('');
    detector.current?.hold();
    if (scan.statusType === 'PACK') soundFx.copySuccess();
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = manager.subscribe((type, scan) => {
      if (type === 'SCAN_CONFIRMED' && scan.source === 'cover' && guard.current !== 'confirm') showPack(scan);
    });
    return () => { mounted.current = false; activeLookup.current?.abort(); unsubscribe(); };
  }, [manager]);

  function calibrate() {
    detector.current = createCaptureDetector();
    setCameraState('calibrating');
  }

  function nextBook() {
    vectorPhoto.current = null;
    setLookup(null); setFailedLookup(null); setError(''); setQuery('');
  }

  const prevModeRef = useRef(tab);
  useEffect(() => {
    if (prevModeRef.current !== tab) {
      prevModeRef.current = tab;
      if (cameraLive && cameraState !== 'calibrating') detector.current?.hold();
      nextBook();
      setPacked(null);
    }
  }, [tab, cameraLive, cameraState]);

  async function runLookup(mode, makeRequest, comparisonOf) {
    if (guard.current || locked || manager.pending || manager.busy) return;
    guard.current = mode;
    setBusy(mode); setError(''); setFailedLookup(null);
    vectorPhoto.current = null;
    setLookup(null); setPacked(null);
    detector.current?.hold();
    const controller = new AbortController();
    activeLookup.current = controller;
    const started = performance.now();
    try {
      const [route, init] = await makeRequest();
      controller.signal.throwIfAborted();
      const response = await manager.fetch(route, { ...init, method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
      const result = await response.json();
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok) {
        setFailedLookup(result);
        throw new Error(result.error || 'Lookup could not be completed.');
      }
      if (mode === 'image') {
        result.pilotId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
        savePilotObservation(result.pilotId, { at: new Date().toISOString(), status: result.status,
          matchType: result.candidates[0]?.matchType, reviewReasons: result.reviewReasons, wouldPack: result.autoPack,
          lookupMs: Math.round(performance.now() - started), visionUsage: result.visionUsage,
          searchMethod: result.searchMethod, vectorReason: result.vectorReason, matchedIsbn: result.matchedIsbn, comparisonOf,
          vectorTopIsbns: result.vectorTopIsbns,
          candidates: result.candidates.map(({ isbn, order }) => ({ isbn, order })) });
      }
      setLookup(result);
      if (result.autoConfirm && result.candidates[0]?.confirmationToken && !manager.pending && !manager.busy) {
        await saveConfirmation(result.candidates[0], result, true);
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure.name === 'TimeoutError' ? 'Lookup timed out. Retake the photo or search by title.' : failure.message);
    } finally {
      guard.current = null;
      activeLookup.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  function capture(trigger) {
    if (!cameraLive || locked || guard.current || manager.pending || manager.busy) return;
    void runLookup('image', async () => {
      const image = await takeCoverPhoto(camera.video.current, document.createElement('canvas'));
      if (mounted.current) setLastCapture(trigger);
      if (tab === 'vector') vectorPhoto.current = image;
      return photoRequest(image, manager.station, tab === 'vector' ? 'vector' : photoMode);
    });
  }

  function searchPhotoByTitle() {
    const image = vectorPhoto.current;
    if (tab !== 'vector' || !image || guard.current || locked) return;
    setPreferredTab('title');
    setPhotoMode('ocr');
    void runLookup('image', () => photoRequest(image, manager.station, 'ocr', true), lookup?.pilotId);
  }

  function searchMaster(value) {
    void runLookup('search', () => ['/api/cover-match/search', {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: value }),
    }]);
  }

  function search(event) {
    event.preventDefault();
    if (tab === 'title' && query.trim()) searchMaster(query.trim());
  }

  function chooseCandidate(candidate) {
    if (candidate.matchType === 'cover_suggestion') setPackSuggestion(candidate);
    else void confirm(candidate);
  }

  async function confirm(candidate) {
    if (guard.current || (candidate ? locked : !pendingCover || manager.busy || !manager.connected)) return;
    await saveConfirmation(candidate, lookup, false);
  }

  async function saveConfirmation(candidate, result, automatic) {
    guard.current = 'confirm';
    setBusy('confirm'); setError('');
    soundFx.init();
    try {
      const scan = await (candidate ? manager.confirmCover(candidate, result.catalogVersion) : manager.retryPending());
      savePilotObservation(result?.pilotId, { automatic, confirmed: { isbn: scan.isbn, order: scan.order, status: scan.statusType } });
      if (mounted.current) showPack(scan);
    } catch (failure) {
      if (mounted.current) {
        setError(failure.message);
        if (failure.lookup) {
          const refreshed = failure.lookup;
          const candidates = refreshed.candidates.map(choice =>
            choice.matchType === candidate?.matchType && choice.isbn === candidate.isbn
              ? { ...choice, coverUrl: candidate.coverUrl, amazonIsbn: candidate.amazonIsbn,
                listingTitle: candidate.listingTitle, sharedCover: candidate.sharedCover } : choice);
          setLookup({ searchMethod: result?.searchMethod,
            ...refreshed, candidates, pilotId: result?.pilotId });
        }
        else if (failure.status === 409) setLookup(null);
      }
    } finally {
      guard.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  actions.current = { capture, manual: cameraLive && !locked && !packSuggestion, auto: auto && !locked && !lookup && !error && !query.trim() };
  useEffect(() => {
    if (camera.status !== 'live') return;
    calibrate();
    const sampleFrame = makeFrameSampler(document.createElement('canvas'));
    const timer = setInterval(() => {
      if (document.hidden || !camera.video.current) return;
      const frame = sampleFrame(camera.video.current);
      if (!frame) return;
      const current = actions.current;
      const next = detector.current.sample(frame, performance.now(), current.auto && !guard.current && !manager.pending && !manager.busy);
      setCameraState(next.state);
      if (next.capture) current.capture('automatic');
    }, 100);
    return () => clearInterval(timer);
  }, [camera.status, camera.video, manager]);

  useEffect(() => {
    const onKey = event => {
      if (actions.current.manual && matchesPedal(event, pedal)) {
        event.preventDefault();
        actions.current.capture('foot pedal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pedal]);

  const suggestionActions = { locked, onPack: chooseCandidate, onMoreInfo: setInfoItem, onPreview: setPreviewImage };
  const sharedSuggestion = packSuggestion && (packSuggestion.sharedCover || (packSuggestion.amazonIsbn &&
    lookup?.reviewSuggestions?.some(hit => hit.isbn !== packSuggestion.isbn && hit.amazonIsbn === packSuggestion.amazonIsbn)));

  return <Stack component="section" className="cover-match" gap={2} aria-label="Cover Match">
    {enabled && manager.connected && !vectorAvailable && <Typography variant="body2" color="text.secondary">
      Vector search is unavailable at this station.
    </Typography>}
    {!enabled && <Alert severity="info">Cover Match is disabled on this server. Set COVER_MATCH_ENABLED to true in the server environment to use it.</Alert>}
    {enabled && (!manager.connected || !manager.ready) && <Alert severity="warning">{manager.connected ? 'Reconcile the packing catalog before confirming copies.' : 'Waiting for the packing server. You can still check the camera preview.'}</Alert>}
    {manager.pending && <Alert severity="warning" action={pendingCover && <Button disabled={busy === 'confirm' || manager.busy || !manager.connected} onClick={() => void confirm()}>Retry now</Button>}>
      {pendingCover ? 'Confirming the selected box. Keep this book aside while the saved request recovers.' : 'A barcode scan is pending. Confirm its result before processing another book.'}
    </Alert>}

    <Box role="tabpanel" id="cover-search-panel" className="cover-match-panels">
      <Box sx={{ minWidth: 0 }}>
        <Stack gap={1}>
          {cameraLive && <Stack direction="row" justifyContent="flex-end" alignItems="center">
            <Chip label={cameraState === 'ready' && !actions.current.auto
              ? auto ? 'Auto capture paused' : 'Manual capture mode'
              : stateLabels[cameraState]} size="small" color={cameraState === 'ready' && actions.current.auto ? 'success' : 'default'} />
          </Stack>}
          <div className={`cover-camera-preview${cameraLive ? ' is-live' : ''}`}>
            <video ref={camera.video} muted playsInline autoPlay aria-label="Live document camera" />
            {cameraLive ? <div className="cover-camera-guide" style={{ inset: `${CAPTURE_INSET * 100}%` }} aria-hidden="true" />
              : <div className="cover-camera-placeholder"><PhotoCamera fontSize="medium" /><Typography variant="body2">{camera.status === 'starting' ? 'Starting camera…' : 'Clear area before starting.'}</Typography></div>}
          </div>
          {camera.error && <Alert severity="warning" sx={{ py: .25 }}>{camera.error}</Alert>}
          <TextField select size="small" label="Camera device" value={camera.devices.some(device => device.deviceId === camera.selected) ? camera.selected : ''}
            disabled={camera.status === 'starting' || Boolean(busy)} onChange={event => camera.select(event.target.value)} fullWidth>
            <MenuItem value="">Preferred or default camera</MenuItem>
            {camera.devices.filter(device => device.deviceId).map((device, i) => <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${i + 1}`}</MenuItem>)}
          </TextField>
          <Stack direction="row" flexWrap="wrap" gap={.75}>
            {cameraLive ? <>
              <Button variant="contained" size="small" aria-disabled={locked} onClick={() => capture('button')} startIcon={<PhotoCamera />} sx={{ minHeight: 36, '&[aria-disabled="true"]': { opacity: .55 } }}>{lookup || error ? 'Retake photo' : 'Capture photo'}</Button>
              <Button size="small" onClick={camera.stop} sx={{ minHeight: 36 }}>Stop</Button>
              <Button size="small" disabled={Boolean(busy) || Boolean(manager.pending)} onClick={() => { nextBook(); calibrate(); }} sx={{ minHeight: 36 }}>Calibrate</Button>
            </> : camera.status === 'starting' ? <Button size="small" onClick={camera.stop} sx={{ minHeight: 36 }}>Cancel</Button>
              : <Button variant="outlined" size="small" startIcon={<PhotoCamera />} onClick={() => void camera.start()} sx={{ minHeight: 36 }}>Start camera</Button>}
          </Stack>
          {lastCapture && <Typography variant="caption" color="text.secondary">Last capture: {lastCapture}</Typography>}
          <Stack direction="row" flexWrap="wrap" justifyContent="space-between" gap={1} alignItems="center">
            {tab === 'title' && <TextField select size="small" label="Photo type" value={photoMode} disabled={Boolean(busy)} onChange={event => setPhotoMode(event.target.value)} sx={{ minWidth: 130, flex: 1 }}>
              <MenuItem value="ocr">Front cover</MenuItem>
              <MenuItem value="isbn">ISBN page</MenuItem>
            </TextField>}
            <FormControlLabel control={<Switch size="small" checked={auto} onChange={event => setAuto(event.target.checked)} />} label={<Typography variant="body2">Auto capture</Typography>} sx={{ mr: 0 }} />
            <TextField size="small" label="Foot pedal key" value={pedal} slotProps={{ htmlInput: { maxLength: 12 } }} onChange={event => {
              setPedal(event.target.value);
              try { localStorage.setItem(pedalStorageKey, event.target.value); } catch { /* Keep the setting for this visit. */ }
            }} sx={{ width: 110 }} />
          </Stack>
        </Stack>
      </Box>

      <Stack gap={1.5} minWidth={0}>
        {tab === 'title' && <Paper variant="outlined" sx={{ p: 1.75 }}>
          <Typography component="h2" variant="subtitle1" fontWeight={700} sx={{ mb: 1.25 }}>Search by title or ISBN</Typography>
          <Stack component="form" onSubmit={search} direction={{ xs: 'column', sm: 'row' }} gap={1}>
            <TextField fullWidth value={query} onChange={event => setQuery(event.target.value)} placeholder="Type a title or ISBN" slotProps={{ htmlInput: { 'aria-label': 'Title or ISBN', maxLength: 300 } }} />
            <Button variant="outlined" type="submit" disabled={locked || !query.trim()} startIcon={<Search />} sx={{ minHeight: 44 }}>Search</Button>
          </Stack>
        </Paper>}
        <Stack gap={1.25} aria-live="polite">
          {busy && <Alert severity="info" icon={<CircularProgress size={19} />}>{busy === 'image'
            ? tab === 'vector' ? 'Searching by cover image…' : 'Reading the photo with Gemini OCR…'
            : busyLabels[busy]}</Alert>}
          {tab === 'title' && searchLabels[resultSource?.searchMethod] && (lookup || error) &&
            <Chip label={searchLabels[resultSource.searchMethod]} size="small" sx={{ alignSelf: 'flex-start' }} />}
          {resultSource?.partialSearch && <Alert severity="warning">One cover collection is unavailable. Showing the results we received.</Alert>}
          {resultSource?.vectorReason && <Alert severity="info">{vectorReasonLabels[resultSource.vectorReason]}</Alert>}
          {error && <Alert severity="warning">{error}</Alert>}
          {lookup?.reviewReasons.includes('verify_fallback_isbn') && lookup.extracted?.title_as_printed &&
            <Typography variant="body2"><strong>Gemini OCR read</strong> · {lookup.extracted.title_as_printed}</Typography>}
          {packed && !manager.pending && <Alert severity={packed.statusType === 'PACK' ? 'success' : 'warning'} sx={{ py: 1.5 }}>
            <div className="cover-box-callout">{packed.statusType === 'PACK' ? `BOX ${packed.order}` : packed.statusType}</div>
            <Typography variant="body2" sx={{ mt: .5 }}>{packed.title || packed.isbn}</Typography>
          </Alert>}
          {lookup?.status === 'DUPLICATE' && <Alert severity="warning">
            {lookup.searchMethod === 'cover_vector' ? `Already packed. Set this book aside. ${lookup.matchedTitle || lookup.matchedIsbn}` : 'DUPLICATE. Set this book aside.'}
          </Alert>}
          {lookup?.status === 'NO_MATCH' && !lookup.vectorReason && <Alert severity="info">{lookup.reviewReasons.includes('isbn_not_recognized')
            ? 'No recognized ISBN. Retake the ISBN page or type the number.'
            : 'No confident match. Retake the photo or try typed search.'}</Alert>}
          {lookup?.status === 'REVIEW' && <Alert severity="warning">{lookup.reviewReasons.includes('verify_fallback_isbn')
            ? 'These title suggestions need ISBN verification. Use ISBN page or type the ISBN printed on the book.'
            : lookup.candidates.some(candidate => candidate.amazonIsbn && candidate.matchType !== 'cover_suggestion')
            ? 'Check the book and verify any replacement ISBN before packing.'
            : lookup.candidates.length ? 'Review the matches and confirm the correct eligible box.' : 'This edition needs review. Verify the book and search by title.'}</Alert>}
          {lookup?.autoPack && !busy && <Typography variant="body2" color="text.secondary">Pilot check would auto-pack box {lookup.autoPack.order}. Confirm to save.</Typography>}
          <Candidates lookup={lookup} locked={locked} onConfirm={chooseCandidate} onMoreInfo={setInfoItem} onPreview={setPreviewImage} />
          {(lookup || error) && <VectorSuggestions suggestions={resultSource?.reviewSuggestions} review {...suggestionActions} />}
          {(lookup || error) && <VectorSuggestions suggestions={resultSource?.vectorSuggestions} {...suggestionActions} />}
        </Stack>
      </Stack>
    </Box>
    <Dialog open={Boolean(previewImage)} onClose={() => setPreviewImage(null)} maxWidth="md" aria-labelledby="cover-preview-title"
      slotProps={{ paper: { sx: { bgcolor: '#141414', p: 1.5, position: 'relative' } } }}>
      {previewImage && <>
        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} sx={{ mb: 1, pl: 1 }}>
          <Typography id="cover-preview-title" fontWeight={700} noWrap sx={{ flex: 1 }}>{previewImage.title}</Typography>
          <IconButton aria-label="Close preview" onClick={() => setPreviewImage(null)} size="small">
            <Close />
          </IconButton>
        </Stack>
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', maxHeight: '82vh', overflow: 'hidden' }}>
          <Box component="img" src={previewImage.src} alt={previewImage.title || ''} referrerPolicy="no-referrer"
            sx={{ maxWidth: '100%', maxHeight: '80vh', width: 'auto', height: 'auto', objectFit: 'contain', borderRadius: 1 }} />
        </Box>
      </>}
    </Dialog>
    <Dialog open={Boolean(infoItem)} onClose={() => setInfoItem(null)} fullWidth maxWidth="xs" aria-labelledby="cover-more-info-title">
      {infoItem && <>
        <DialogTitle id="cover-more-info-title">{infoItem.listingTitle || infoItem.title || infoItem.isbn}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.25}>
            {infoItem.coverUrl && <VectorCoverThumbnail src={infoItem.coverUrl} similarity={typeof infoItem.score === 'number' && infoItem.score <= 1 ? infoItem.score.toFixed(3) : undefined} />}
            {infoItem.title && <Typography variant="body2"><strong>Master title:</strong> {infoItem.title}</Typography>}
            {infoItem.listingTitle && infoItem.listingTitle !== infoItem.title && (
              <Typography variant="body2"><strong>Listing title:</strong> {infoItem.listingTitle}</Typography>
            )}
            {infoItem.author && <Typography variant="body2"><strong>Author:</strong> {infoItem.author}</Typography>}
            <Typography variant="body2"><strong>PO ISBN:</strong> {infoItem.isbn}</Typography>
            {infoItem.amazonIsbn && (
              <Typography variant="body2"><strong>{infoItem.review ? 'Amazon ISBN' : 'Replacement ISBN'}:</strong> {infoItem.amazonIsbn}</Typography>
            )}
            {typeof infoItem.score === 'number' && (
              <Typography variant="body2"><strong>Score:</strong> {infoItem.score <= 1 ? `${infoItem.score.toFixed(3)} similarity` : infoItem.score}</Typography>
            )}
            {infoItem.order && <Typography variant="body2"><strong>Box:</strong> {infoItem.order}</Typography>}
            {infoItem.remaining != null && <Typography variant="body2"><strong>Remaining copies:</strong> {infoItem.remaining}</Typography>}
            {infoItem.alreadyPacked && <Typography variant="body2" color="warning.main"><strong>Status:</strong> Already packed</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInfoItem(null)}>Close</Button>
        </DialogActions>
      </>}
    </Dialog>
    <Dialog open={Boolean(packSuggestion)} onClose={() => setPackSuggestion(null)} aria-labelledby="cover-pack-suggestion-title">
      {packSuggestion && <>
        <DialogTitle id="cover-pack-suggestion-title">Mark as packed in box {packSuggestion.order}?</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography fontWeight={700}>{packSuggestion.title}</Typography>
            <Typography>PO ISBN {packSuggestion.isbn}</Typography>
            {packSuggestion.amazonIsbn && <Typography>Amazon ISBN {packSuggestion.amazonIsbn}</Typography>}
            {sharedSuggestion && <Alert severity="warning">This cover is shared by more than one PO ISBN.</Alert>}
            <Typography>Check the physical book and the selected PO before confirming.</Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => setPackSuggestion(null)}>Cancel</Button>
          <Button variant="contained" disabled={locked} onClick={() => {
            const candidate = packSuggestion;
            setPackSuggestion(null);
            void confirm(candidate);
          }}>Confirm box {packSuggestion.order}</Button>
        </DialogActions>
      </>}
    </Dialog>
  </Stack>;
}
