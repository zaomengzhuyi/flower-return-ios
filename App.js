import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import { useAudioPlayer } from 'expo-audio';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

const TOKEN_KEY = 'flower_return_token';
const SERVER_KEY = 'flower_return_server';
const ZOOM_KEY = 'flower_return_zoom_level';

async function request(server, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${server.replace(/\/$/, '')}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!response.ok) throw new Error(data?.message || `请求失败 ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

function Field({ label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor="#9aa8a7" {...props} />
    </View>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [server, setServer] = useState('http://192.168.1.100:8787');
  const [token, setToken] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [deviceName, setDeviceName] = useState('老板手机');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState('home');
  const [query, setQuery] = useState('');
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState('return');
  const [scanHint, setScanHint] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [scanLock, setScanLock] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const scanPlayer = useAudioPlayer(require('./assets/beep.wav'));
  const successPlayer = useAudioPlayer(require('./assets/success.wav'));
  const failPlayer = useAudioPlayer(require('./assets/fail.wav'));
  const [previewIndex, setPreviewIndex] = useState(0);
  const { width: screenWidth } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('back');
  const [flash, setFlash] = useState('off');
  const [zoom, setZoom] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(0);
  const [lenses, setLenses] = useState([]);
  const [selectedLens, setSelectedLens] = useState(undefined);
  const cameraRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const savedZoom = await SecureStore.getItemAsync(ZOOM_KEY);
        if (savedZoom !== null) { const level = Math.max(0, Math.min(20, Number(savedZoom) || 0)); setZoomLevel(level); setZoom(level * 0.05); }
        const savedServer = await SecureStore.getItemAsync(SERVER_KEY);
        const savedToken = await SecureStore.getItemAsync(TOKEN_KEY);
        if (savedServer) setServer(savedServer);
        if (savedToken && savedServer) setToken(savedToken);
      } finally { setReady(true); }
    })();
  }, []);

  const pair = async () => {
    setError(''); setBusy(true);
    try {
      const data = await request(server, '/api/mobile/pair', {
        method: 'POST',
        body: JSON.stringify({ code: pairCode.trim(), name: deviceName.trim() || '手机' }),
      });
      await SecureStore.setItemAsync(SERVER_KEY, server.replace(/\/$/, ''));
      await SecureStore.setItemAsync(TOKEN_KEY, data.token);
      setToken(data.token);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const search = async () => {
    if (!query.trim()) return;
    setError(''); setBusy(true);
    try {
      const data = await request(server, `/api/mobile/orders/search?q=${encodeURIComponent(query.trim())}`, {
        headers: { 'x-mobile-token': token },
      });
      setOrders(data.orders || []);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const openOrder = async (order) => {
    setError(''); setBusy(true);
    try {
      const data = await request(server, `/api/mobile/orders/${encodeURIComponent(order.id)}`, {
        headers: { 'x-mobile-token': token },
      });
      setSelected(data.order);
      setPhotos([]);
      setScreen('detail');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const loadLenses = async () => {
    try {
      const list = await cameraRef.current?.getAvailableLensesAsync?.();
      if (Array.isArray(list)) {
        setLenses(list);
        if (!selectedLens) {
          const wide = list.find((item) => /WideAngleCamera/i.test(item.deviceType) && !/UltraWide/i.test(item.deviceType));
          if (wide) setSelectedLens(wide.deviceType);
        }
      }
    } catch {}
  };

  const selectZoom = (level) => {
    setZoomLevel(level);
    const wide = lenses.find((item) => /WideAngleCamera/i.test(item.deviceType) && !/UltraWide/i.test(item.deviceType));
    if (wide) setSelectedLens(wide.deviceType);
    if (level === 0) setZoom(0);
    else if (level === 1) setZoom(0.25);
    else setZoom(0.5);
  };

  const applyMicroZoom = async (next) => {
    const level = Math.max(0, Math.min(20, next));
    setZoomLevel(level);
    setZoom(level * 0.05);
    try { await SecureStore.setItemAsync(ZOOM_KEY, String(level)); } catch {}
  };

  const openCamera = async (mode) => {
    setCameraMode(mode);
    const result = permission?.granted ? permission : await requestPermission();
    if (result.granted) setCameraOpen(true);
    else setError('需要相机权限才能拍照');
  };

  const onBarcodeScanned = async (result) => {
    if (scanLock || !result?.data) return;
    try { scanPlayer.seekTo(0); scanPlayer.play(); } catch {}
    const no = String(result.data).replace(/[^0-9]/g, '');
    if (!no) return;
    setScanLock(true); setScanBusy(true); setError('');
    try {
      const data = await request(server, `/api/mobile/orders/by-short?no=${encodeURIComponent(no)}`, { headers: { 'x-mobile-token': token } });
      setOrders(data.orders || []);
      setCameraOpen(false);
      if (data.orders?.length) { setSelected(data.orders[0]); setScreen('detail'); }
      else { setScreen('home'); setScanHint(`扫描到 #${no}，没有找到订单`); }
    } catch (err) { setError(err.message); } finally { setScanBusy(false); setScanLock(false); }
  };

  const captureScan = async () => {
    if (!cameraRef.current) return;
    setScanBusy(true); setError('');
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, base64: true });
      if (!photo?.base64) throw new Error('拍摄失败');
      const data = await request(server, '/api/mobile/ocr', {
        method: 'POST',
        headers: { 'x-mobile-token': token },
        body: JSON.stringify({ image: `data:image/jpeg;base64,${photo.base64}` }),
      });
      setOrders(data.orders || []);
      setCameraOpen(false); setScreen('home');
      const label = data.orderNo ? `#${data.orderNo}` : (data.phones?.[0] || data.address || '');
      setScanHint(data.orders?.length ? `识别到 ${label || '标签'}，请确认订单` : `识别到 ${label || '标签'}，但未找到订单`);
    } catch (err) { setError(err.message); } finally { setScanBusy(false); }
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, base64: true, exif: true, skipProcessing: false });
      let base64 = photo?.base64;
      if (photo?.uri) {
        const actions = [];
        if (photo.width && photo.width > 1400) actions.push({ resize: { width: 1200 } });
        const fixed = await manipulateAsync(photo.uri, actions, { compress: 0.7, format: SaveFormat.JPEG, base64: true });
        base64 = fixed.base64 || base64;
      }
      if (base64) setPhotos((prev) => [...prev, `data:image/jpeg;base64,${base64}`]);
    } catch (err) { setError(err.message); }
  };

  const upload = async () => {
    if (!selected || !photos.length) return;
    setBusy(true); setError('');
    try {
      await request(server, `/api/mobile/orders/${encodeURIComponent(selected.id)}/photos`, {
        method: 'POST',
        headers: { 'x-mobile-token': token },
        body: JSON.stringify({ files: photos.map((data, index) => ({ name: `return-${index + 1}.jpg`, type: 'image/jpeg', data })) }),
      });
      try { successPlayer.seekTo(0); successPlayer.play(); } catch {}
      Alert.alert('返图成功', `已上传 ${photos.length} 张实拍图，并已标记已拣货`);
      setCameraOpen(false); setPhotos([]); setScreen('home');
    } catch (err) { try { failPlayer.seekTo(0); failPlayer.play(); } catch {} setError(err.message); Alert.alert('上传失败', err.message); } finally { setBusy(false); }
  };

  const unpair = async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(''); setScreen('home'); setOrders([]); setSelected(null);
  };

  if (!ready) return <SafeAreaView style={styles.center}><ActivityIndicator size="large" color="#92c83e" /></SafeAreaView>;

  if (!token) {
    return (
      <SafeAreaView style={styles.page}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.pairWrap}>
          <Text style={styles.logo}>花生返图</Text>
          <Text style={styles.subtitle}>连接电脑上的花生工作台</Text>
          <Field label="工作台地址" value={server} onChangeText={setServer} autoCapitalize="none" keyboardType="url" placeholder="http://192.168.1.100:8787" />
          <Field label="6 位配对码" value={pairCode} onChangeText={setPairCode} keyboardType="number-pad" maxLength={6} placeholder="电脑设置页显示的配对码" />
          <Field label="设备名称" value={deviceName} onChangeText={setDeviceName} placeholder="例如：老板手机" />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.primary} onPress={pair} disabled={busy}>
            {busy ? <ActivityIndicator color="#31472d" /> : <Text style={styles.primaryText}>连接工作台</Text>}
          </Pressable>
          <Text style={styles.hint}>电脑和手机需要连接同一个 Wi-Fi，电脑工作台保持运行。</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (cameraOpen && cameraMode === 'scan') {
    return (
      <SafeAreaView style={styles.scanPage}>
        <View style={styles.scanTopBar}>
          <Pressable onPress={() => setCameraOpen(false)} style={styles.scanTopButton}><Text style={styles.scanTopText}>‹ 取消</Text></Pressable>
          <Text style={styles.scanTopTitle}>扫描订单条形码</Text>
          <Pressable onPress={() => setFlash((value) => (value === 'on' ? 'off' : 'on'))} style={styles.scanTopButton}><Text style={styles.scanTopText}>{flash === 'on' ? '灯开' : '灯关'}</Text></Pressable>
        </View>
        <View style={styles.scanStage}>
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" flash={flash} onBarcodeScanned={onBarcodeScanned} barcodeScannerSettings={{ barcodeTypes: ['code128', 'code39', 'ean13'] }} />
          <View pointerEvents="none" style={styles.scanFrame} />
        </View>
        <View style={styles.scanFooter}>
          <Text style={styles.scanTip}>{scanBusy ? '正在查询订单…' : '把标签上的条形码放入框内'}</Text>
          <Text style={styles.scanSubTip}>扫描成功后会自动进入订单详情</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (cameraOpen && selected) {
    return (
      <SafeAreaView style={styles.cameraPage}>
        <View style={styles.cameraTopBar}>
          <Pressable onPress={() => setCameraOpen(false)} style={styles.cameraTopButton}><Text style={styles.cameraTopText}>‹ 返回</Text></Pressable>
          <Text style={styles.cameraTopTitle}>实拍返图</Text>
          <View style={styles.cameraTopButton} />
        </View>
        <View style={styles.cameraStage}>
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" flash="off" zoom={zoom} />
        </View>
        <View style={styles.cameraPanel}>
          <View style={styles.microZoomRow}>
            <Pressable style={styles.microZoomButton} onPress={() => applyMicroZoom(zoomLevel - 1)}><Text style={styles.microZoomText}>－</Text></Pressable>
            <Text style={styles.microZoomLabel}>微调档位 {zoomLevel}</Text>
            <Pressable style={styles.microZoomButton} onPress={() => applyMicroZoom(zoomLevel + 1)}><Text style={styles.microZoomText}>＋</Text></Pressable>
          </View>
          {photos.length > 0 && (
            <View style={styles.photoBar}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>{photos.map((src, index) => (
                <View key={`${src}-${index}`} style={styles.photoWrap}>
                  <Pressable onPress={() => { setPreviewIndex(index); setPreviewPhoto(src); }}><Image source={{ uri: src }} style={styles.photoThumb} /></Pressable>
                  <Pressable style={styles.photoDelete} onPress={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}><Text style={styles.photoDeleteText}>×</Text></Pressable>
                </View>
              ))}</ScrollView>
              <Pressable onPress={() => setPhotos([])}><Text style={styles.clearPhotos}>清空</Text></Pressable>
            </View>
          )}
          {error ? <Text style={styles.cameraError}>{error}</Text> : null}
          <View style={styles.cameraActions}>
            <View style={styles.cameraActionSide} />
            <View style={styles.shutterWrap}><Pressable style={styles.shoot} onPress={takePhoto}><View style={styles.shootInner} /></Pressable></View>
            <Pressable style={[styles.uploadButton, (!photos.length || busy) && styles.disabled]} onPress={upload} disabled={!photos.length || busy}><Text style={styles.uploadButtonText}>{busy ? '上传中…' : '上传'}</Text></Pressable>
          </View>
        </View>
        <Modal visible={!!previewPhoto} transparent animationType="fade" onRequestClose={() => setPreviewPhoto(null)}>
          <View style={styles.photoPreviewMask}>
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              contentOffset={{ x: previewIndex * screenWidth, y: 0 }}
              onMomentumScrollEnd={(event) => setPreviewIndex(Math.round(event.nativeEvent.contentOffset.x / screenWidth))}
            >
              {photos.map((src, index) => (
                <View key={`preview-${index}`} style={[styles.photoPreviewPage, { width: screenWidth }]}>
                  <Pressable style={styles.photoPreviewTapArea} onPress={() => setPreviewPhoto(null)}>
                    <Image source={{ uri: src }} style={styles.photoPreviewImage} resizeMode="contain" />
                  </Pressable>
                  <Text style={styles.photoPreviewCount}>{index + 1}/{photos.length}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  if (screen === 'detail' && selected) {
    return (
      <SafeAreaView style={styles.page}>
        <ScrollView contentContainerStyle={styles.detailWrap}>
          <View style={styles.detailHero}>
            <View>
              <Text style={styles.detailEyebrow}>订单详情</Text>
              <Text style={styles.orderNo}>#{selected.short_no}</Text>
            </View>
            <Text style={styles.statusBadge}>{selected.status_text || '待处理'}</Text>
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>收货人</Text>
            <View style={styles.detailPersonRow}>
              <Text style={styles.name}>{selected.receiver_name || '匿名'}</Text>
              <Text style={styles.phone}>{selected.receiver_phone || ''}</Text>
            </View>
            <View style={styles.addressBlock}>
              <Text style={styles.infoLabel}>收货地址</Text>
              <Text style={styles.address}>{selected.address_main || '地址待同步'}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>商品信息</Text>
          {(selected.goods || []).map((goods, index) => (
            <View key={`${goods.name}-${index}`} style={styles.goodsRow}>
              {goods.thumb ? <Image source={{ uri: `${server.replace(/\/$/, '')}/api/image?url=${encodeURIComponent(goods.thumb)}` }} style={styles.goodsImage} /> : <View style={styles.goodsPlaceholder}><Text>✿</Text></View>}
              <View style={styles.goodsText}><Text style={styles.goodsName}>{goods.name}</Text><Text style={styles.goodsSpec}>{goods.spec || ''} × {goods.qty || 1}</Text></View>
            </View>
          ))}
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable style={styles.primary} onPress={() => openCamera('return')}>
            <Text style={styles.primaryText}>拍照返图</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => { setSelected(null); setScreen('home'); }}>
            <Text style={styles.secondaryButtonText}>返回扫描</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.settingsTop}>
          <Pressable onPress={() => setScreen('home')}><Text style={styles.back}>‹ 返回</Text></Pressable>
          <Text style={styles.settingsTitle}>设置</Text>
          <View style={{ width: 48 }} />
        </View>
        <View style={styles.settingsCard}>
          <Text style={styles.infoLabel}>工作台地址</Text>
          <Text style={styles.settingsValue}>{server}</Text>
          <Text style={styles.infoLabel}>连接状态</Text>
          <Text style={styles.settingsOnline}>已连接</Text>
          <Pressable style={styles.unpairButton} onPress={async () => { await unpair(); setScreen('home'); }}>
            <Text style={styles.unpairButtonText}>解除配对</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}><View /><Pressable onPress={() => setScreen('settings')}><Text style={styles.unpair}>设置</Text></Pressable></View>
      <View style={styles.homeCenter}>
        <Pressable style={({ pressed }) => [styles.scanCircle, pressed && styles.scanCirclePressed]} onPress={() => openCamera('scan')}>
          <Text style={styles.scanCircleTitle}>扫描</Text>
          <Text style={styles.scanCircleSub}>订单标签</Text>
        </Pressable>
        <Text style={styles.scanHint}>点击按钮，对准标签条形码</Text>
        {scanHint ? <Text style={styles.scanHint}>{scanHint}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f3f6f3', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f3f6f3' },
  pairWrap: { padding: 28, paddingTop: 70 },
  logo: { fontSize: 30, fontWeight: '800', color: '#2f4430', letterSpacing: 1 },
  subtitle: { color: '#788a7e', marginTop: 8, marginBottom: 30 },
  field: { marginBottom: 16 },
  label: { fontSize: 13, color: '#61756a', marginBottom: 7 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#dce7df', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, fontSize: 16, color: '#24352b' },
  primary: { backgroundColor: '#d6ef8c', borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  primaryText: { color: '#31472d', fontWeight: '700', fontSize: 16 },
  hint: { color: '#87958b', fontSize: 12, lineHeight: 19, marginTop: 15 },
  error: { color: '#c94836', marginTop: 8, marginBottom: 8 },
  homeCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  scanCircle: { width: 190, height: 190, borderRadius: 95, backgroundColor: '#d6ef8c', borderWidth: 8, borderColor: '#eef8cf', alignItems: 'center', justifyContent: 'center', shadowColor: '#4b6b37', shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  scanCirclePressed: { transform: [{ scale: 0.96 }], opacity: 0.9 },
  scanCircleTitle: { color: '#31472d', fontSize: 34, fontWeight: '800', letterSpacing: 4 },
  scanCircleSub: { color: '#4f6b3c', fontSize: 18, fontWeight: '600', marginTop: 4 },
  scanRow: { paddingHorizontal: 14, marginTop: 12 },
  scanButton: { backgroundColor: '#3d5d43', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  scanButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  scanHint: { color: '#607b64', fontSize: 12, paddingHorizontal: 14, marginTop: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14 },
  unpair: { color: '#8a9b90', fontSize: 13 },
  searchRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, marginTop: 16 },
  searchInput: { flex: 1 },
  searchButton: { backgroundColor: '#46634b', borderRadius: 10, justifyContent: 'center', paddingHorizontal: 16 },
  searchButtonText: { color: '#fff', fontWeight: '700' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#e4ece6' },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  orderNo: { fontSize: 17, fontWeight: '800', color: '#2f4430' },
  status: { color: '#d48132', fontSize: 12 },
  name: { fontSize: 15, color: '#344a3b', fontWeight: '600' },
  phone: { fontSize: 15, color: '#607b64', fontWeight: '500' },
  address: { color: '#334c58', marginTop: 8, lineHeight: 28, fontSize: 18, fontWeight: '500' },
  goodsName: { color: '#53665a', marginTop: 7, fontSize: 13 },
  empty: { color: '#8a9b90', textAlign: 'center', marginTop: 50 },
  detailWrap: { padding: 18, paddingBottom: 40 },
  detailHero: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  detailEyebrow: { color: '#87958b', fontSize: 12, marginBottom: 4 },
  statusBadge: { color: '#9a6420', backgroundColor: '#fff2d8', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, fontSize: 12 },
  infoCard: { backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#e2ebe5' },
  infoLabel: { color: '#8a9b90', fontSize: 12, marginBottom: 6 },
  detailPersonRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginBottom: 16 },
  addressBlock: { borderTopWidth: 1, borderTopColor: '#edf2ef', paddingTop: 12 },
  sectionTitle: { color: '#3f5848', fontSize: 14, fontWeight: '700', marginTop: 20, marginBottom: 9 },
  secondaryButton: { borderRadius: 10, borderWidth: 1, borderColor: '#c9d9cd', paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  secondaryButtonText: { color: '#526a5a', fontSize: 15, fontWeight: '600' },
  settingsTop: { height: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  settingsTitle: { color: '#2f4430', fontSize: 18, fontWeight: '700' },
  settingsCard: { margin: 18, padding: 18, backgroundColor: '#fff', borderRadius: 14, borderWidth: 1, borderColor: '#e2ebe5' },
  settingsValue: { color: '#334c58', fontSize: 15, marginBottom: 18 },
  settingsOnline: { color: '#5c8c2f', fontSize: 15, marginBottom: 22 },
  unpairButton: { borderWidth: 1, borderColor: '#e1b6ad', borderRadius: 9, paddingVertical: 12, alignItems: 'center' },
  unpairButtonText: { color: '#b94d3a', fontWeight: '600' },
  back: { color: '#607b64', fontSize: 15, marginBottom: 18 },
  goodsRow: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: '#e4ece6' },
  goodsImage: { width: 58, height: 58, borderRadius: 7, backgroundColor: '#eef3ef' },
  goodsPlaceholder: { width: 58, height: 58, borderRadius: 7, backgroundColor: '#eef3ef', alignItems: 'center', justifyContent: 'center' },
  goodsText: { flex: 1, marginLeft: 10 },
  goodsSpec: { color: '#87958b', fontSize: 12, marginTop: 4 },
  scanPage: { flex: 1, backgroundColor: '#000', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0 },
  scanTopBar: { height: 58, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#000' },
  scanTopButton: { minWidth: 62, paddingVertical: 8 },
  scanTopText: { color: '#fff', fontSize: 15 },
  scanTopTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  scanStage: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  scanFrame: { position: 'absolute', left: '12%', right: '12%', top: '34%', height: 160, borderWidth: 2, borderColor: '#d6ef8c', borderRadius: 10 },
  scanFooter: { minHeight: 110, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  scanTip: { color: '#fff', fontSize: 15, fontWeight: '600' },
  scanSubTip: { color: '#93a39a', fontSize: 12, marginTop: 8 },
  cameraError: { color: '#ff8b75', fontSize: 12, textAlign: 'center', paddingHorizontal: 12, marginTop: 6 },
  cameraPage: { flex: 1, backgroundColor: '#000', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0 },
  cameraTopBar: { height: 58, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#000' },
  cameraTopButton: { minWidth: 64, paddingVertical: 8 },
  cameraTopText: { color: '#fff', fontSize: 15 },
  cameraTopTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cameraStage: { width: '100%', aspectRatio: 3 / 4, backgroundColor: '#000', overflow: 'hidden' },
  cameraPanel: { flex: 1, backgroundColor: '#000', paddingHorizontal: 14, paddingTop: 10, justifyContent: 'space-between' },
  zoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  zoomButton: { borderWidth: 1, borderColor: '#555', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  zoomButtonOn: { borderColor: '#d6ef8c', backgroundColor: '#d6ef8c' },
  zoomText: { color: '#aaa', fontSize: 12 },
  zoomTextOn: { color: '#31472d', fontWeight: '700' },
  flipButton: { position: 'absolute', right: 0, paddingVertical: 6 },
  flipText: { color: '#d6ef8c', fontSize: 12 },
  fineZoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 8 },
  fineZoomButton: { width: 34, height: 28, borderRadius: 8, borderWidth: 1, borderColor: '#555', alignItems: 'center', justifyContent: 'center' },
  fineZoomText: { color: '#fff', fontSize: 18 },
  fineZoomHint: { color: '#8f9f94', fontSize: 11 },
  microZoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 8 },
  microZoomButton: { width: 42, height: 36, borderRadius: 9, borderWidth: 1, borderColor: '#666', alignItems: 'center', justifyContent: 'center' },
  microZoomText: { color: '#fff', fontSize: 22 },
  microZoomLabel: { color: '#d6ef8c', fontSize: 13, minWidth: 92, textAlign: 'center' },
  cameraActionSide: { width: 78 },
  uploadButton: { width: 78, backgroundColor: '#d6ef8c', borderRadius: 9, paddingVertical: 11, alignItems: 'center' },
  uploadButtonText: { color: '#31472d', fontWeight: '700', fontSize: 14 },
  photoPreviewMask: { flex: 1, backgroundColor: 'rgba(0,0,0,.96)' },
  photoPreviewTapArea: { flex: 1, width: '100%', justifyContent: 'center' },
  photoPreviewCount: { color: '#fff', fontSize: 16, fontWeight: '500', marginTop: 10, marginBottom: 24 },
  photoPreviewPage: { height: '100%', alignItems: 'center', justifyContent: 'center' },
  photoPreviewImage: { width: '100%', height: '82%' },
  photoPreviewClose: { color: '#fff', fontSize: 14, marginTop: 18 },
  photoBar: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  photoWrap: { width: 66, height: 74, marginRight: 10, paddingTop: 7 },
  photoThumb: { width: 58, height: 62, borderRadius: 6, borderWidth: 1, borderColor: '#fff' },
  photoDelete: { position: 'absolute', top: 1, right: 1, width: 20, height: 20, borderRadius: 10, backgroundColor: '#c94836', alignItems: 'center', justifyContent: 'center' },
  photoDeleteText: { color: '#fff', fontSize: 14, lineHeight: 18 },
  clearPhotos: { color: '#aaa', fontSize: 12, marginLeft: 6 },
  shutterWrap: { alignItems: 'center', flex: 1 },
  cameraActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10 },
  cameraTop: { position: 'absolute', top: 50, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', zIndex: 2 },
  cameraButton: { backgroundColor: 'rgba(0,0,0,.42)', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  cameraClose: { color: '#fff', fontSize: 16 },
  cameraTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cameraCount: { color: '#fff', fontSize: 14 },
  cameraBottom: { position: 'absolute', bottom: 30, left: 0, right: 0, alignItems: 'center' },
  photoStrip: { maxHeight: 70, marginBottom: 12 },
  photoThumb: { width: 52, height: 62, borderRadius: 6, marginHorizontal: 4, borderWidth: 2, borderColor: '#fff' },
  cameraActions: { flexDirection: 'row', alignItems: 'center', gap: 22 },
  shoot: { width: 72, height: 72, borderRadius: 36, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shootInner: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#fff' },
  send: { backgroundColor: '#d6ef8c', borderRadius: 9, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#31472d', fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
