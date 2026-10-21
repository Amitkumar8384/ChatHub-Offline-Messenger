import React, { useEffect, useState, useRef } from 'react';

import {
  Alert,
  Image,
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
  BackHandler,
  ToastAndroid,
  useWindowDimensions,
  Animated,
  Easing,
} from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';

import { nearby } from './src/nearby';
import { requestNearbyPermissions } from './src/nearbyPermissions';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import {
  createIdentityAnnouncement,
  decryptMeshMessage,
  encryptMeshMessage,
  loadOrCreateMeshIdentity,
  verifyIdentityAnnouncement,
  verifyMeshEnvelope,
} from './src/meshCrypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';

const COLORS = {
  background: '#07111B',
  surface: '#101B25',
  card: '#16232E',
  border: '#293A46',
  primary: '#B8F36B',
  text: '#F4F8F6',
  muted: '#A5B2B9',
  green: '#B8F36B',
  purple: '#C6F58D',
  cyan: '#62D8E8',
  mint: '#60D6A8',
  pink: '#F28FB8',
  blue: '#82A7FF',
  violet: '#B49AFF',
  amber: '#F4C76D',
};
const MAX_MESH_HOPS = 4;

function mergeRestoredChats(savedChats, currentChats) {
  const chatKey = chat => chat.id || chat.endpointId;
  const chatsByEndpoint = new Map(savedChats.map(chat => [chatKey(chat), chat]));

  currentChats.forEach(currentChat => {
    const key = chatKey(currentChat);
    const savedChat = chatsByEndpoint.get(key);
    if (!savedChat) {
      chatsByEndpoint.set(key, currentChat);
      return;
    }

    const messagesById = new Map();
    [...(savedChat.messages || []), ...(currentChat.messages || [])].forEach(message => {
      messagesById.set(message.id, message);
    });
    const latestChat = (currentChat.updatedAt || 0) >= (savedChat.updatedAt || 0)
      ? currentChat
      : savedChat;

    chatsByEndpoint.set(key, {
      ...savedChat,
      ...currentChat,
      ...latestChat,
      messages: [...messagesById.values()].sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0)),
    });
  });

  return [...chatsByEndpoint.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function profileKey(id = '') {
  return String(id).replace(/-/g, '').toLowerCase();
}

function profileKeyFromName(name = '') {
  return String(name).match(/\bCH-([A-Z0-9]{8})\b/i)?.[1]?.toLowerCase() || '';
}



function Avatar({ initials, color, size = 52, online = false }) {
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
        borderRadius: size / 2,
          backgroundColor: color || COLORS.card,
        },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.29 }]}>
        {initials}
      </Text>

      {online && (
        <View
          style={[
            styles.onlineDot,
            {
              width: size * 0.22,
              height: size * 0.22,
              borderRadius: size * 0.11,
            },
          ]}
        />
      )}
    </View>
  );
}

function IconButton({
  name,
  onPress,
  size = 20,
  color = COLORS.text,
  style,
  accessibilityLabel,
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || name.replace(/-outline/g, '').replace(/-/g, ' ')}
      style={[styles.iconButton, style]}
    >
      <Ionicons name={name} size={size} color={color} />
    </TouchableOpacity>
  );
}

function SectionTitle({ title, action, onAction }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>

      {action ? (
        <TouchableOpacity onPress={onAction} activeOpacity={0.7}>
          <Text style={styles.sectionAction}>{action}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function EmptyState({ icon, title, description, compact = false }) {
  return (
    <View style={[styles.emptyState, compact && styles.emptyStateCompact]}>
      <View style={[styles.emptyIcon, compact && styles.emptyIconCompact]}>
        <Ionicons name={icon} size={30} color={COLORS.primary} />
      </View>

      <Text style={styles.emptyTitle}>{title}</Text>

      <Text style={[styles.emptyDescription, compact && styles.emptyStateCompactDescription]}>{description}</Text>
    </View>
  );
}

function VoiceMessage({ uri }) {
  const player = useAudioPlayer(uri || null);
  const status = useAudioPlayerStatus(player);

  return (
    <TouchableOpacity
      style={styles.voiceMessageButton}
      accessibilityRole="button"
      accessibilityLabel={status.playing ? 'Pause voice message' : 'Play voice message'}
      onPress={() => status.playing ? player.pause() : player.play()}
      disabled={!uri}
      activeOpacity={0.75}
    >
      <Ionicons
        name={status.playing ? 'pause-circle' : 'play-circle'}
        size={24}
        color={COLORS.primary}
      />
      <Text style={styles.voiceMessageLabel}>
        {status.playing ? 'Playing voice message' : 'Voice message'}
      </Text>
    </TouchableOpacity>
  );
}

export default function App() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [activeTab, setActiveTab] = useState('Home');
  const [searchQuery, setSearchQuery] = useState('');
  const [chatFilter, setChatFilter] = useState('All');
  const [isScanning, setIsScanning] = useState(false);
  const [isQrScannerOpen, setIsQrScannerOpen] = useState(false);
  const [isMyQrOpen, setIsMyQrOpen] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [cameraMountError, setCameraMountError] = useState('');
  const qrScanHandledRef = useRef(false);
  const scanPulse = useRef(new Animated.Value(0)).current;
  const scanningRef = useRef(false);
  const [nearbyDevices, setNearbyDevices] = useState([]);
  const [connectedDevices, setConnectedDevices] = useState([]);
  const connectedDevicesRef = useRef([]);
  const peerByEndpointRef = useRef(new Map());
  const expectedPeerByEndpointRef = useRef(new Map());
  const [chats, setChats] = useState([]);
  const meshIdentityRef = useRef(null);
  const meshPeersRef = useRef(new Map());
  const seenMeshPacketsRef = useRef(new Map());
  const chatsLoadedRef = useRef(false);
  const [messageDraft, setMessageDraft] = useState('');
  const [requests, setRequests] = useState([]);
  const [notice, setNotice] = useState('');
  const [selectedChat, setSelectedChat] = useState(null);
  const selectedChatRef = useRef(null);
  const lastBackPressRef = useRef(0);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedGroupMembers, setSelectedGroupMembers] = useState([]);
  const [profileName, setProfileName] = useState('');
  const [profileId, setProfileId] = useState('');
  const profileIdRef = useRef('');
  const legacyProfileIdRef = useRef('');
  const [profileSetupName, setProfileSetupName] = useState('');
  const [isProfileSetupVisible, setIsProfileSetupVisible] = useState(false);
  const qrCodeSize = Math.min(
    220,
    Math.max(140, Math.min(windowWidth - 184, windowHeight - 560))
  );
  const profileNameDirtyRef = useRef(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const audioRecorder = useAudioRecorder({
    ...RecordingPresets.LOW_QUALITY,
    directory: 'document',
  });
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [blockedDevices, setBlockedDevices] = useState([]);
  const blockedDevicesRef = useRef(new Map());
  const blockedDevicesLoadedRef = useRef(false);

  useEffect(() => {
    connectedDevicesRef.current = connectedDevices;
  }, [connectedDevices]);

  useEffect(() => {
    if (!isScanning) {
      scanPulse.stopAnimation();
      scanPulse.setValue(0);
      return undefined;
    }

    const pulse = Animated.loop(Animated.timing(scanPulse, {
      toValue: 1,
      duration: 1500,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }));
    pulse.start();
    return () => pulse.stop();
  }, [isScanning, scanPulse]);

  function getGeneratedDisplayName(id = profileId) {
    const shortId = id.replace(/-/g, '').slice(0, 6).toUpperCase();
    return shortId ? `User-${shortId}` : 'ChatHub User';
  }

  function getFullProfileId(id = legacyProfileIdRef.current || profileId) {
    return id ? `CH-${id.toUpperCase()}` : '';
  }

  function getPublicDisplayName(name = profileName, id = profileIdRef.current || profileId) {
    id = legacyProfileIdRef.current || id;
    const shortId = id.replace(/-/g, '').slice(0, 8).toUpperCase();
    const displayName = name.trim() || getGeneratedDisplayName(id);
    return shortId ? `${displayName} · CH-${shortId}` : displayName;
  }

  function getNearbyEndpointName(name = profileName, id = profileIdRef.current || profileId) {
    const displayName = name.trim() || getGeneratedDisplayName(id);
    return id ? `${displayName.slice(0, 80)} · CH-${id}` : displayName;
  }

  function getEndpointPeerId(endpointName = '') {
    return String(endpointName).match(/(?:^|\s)CH-([\da-f]{64})(?:$|\s)/i)?.[1]?.toLowerCase() || '';
  }

  function getEndpointDisplayName(endpointName = '') {
    return String(endpointName).replace(/\s*[·•]?\s*CH-[\da-f]{64}(?:$|\s)/i, '').trim() || 'Nearby device';
  }

  function rememberMeshPeer(peer) {
    const known = meshPeersRef.current.get(peer.id);
    if (known && (known.signingPublicKey !== peer.signingPublicKey
      || known.encryptionPublicKey !== peer.encryptionPublicKey)) return false;
    meshPeersRef.current.set(peer.id, { ...known, ...peer });
    AsyncStorage.setItem('@chathub/mesh-peers', JSON.stringify([...meshPeersRef.current.values()]))
      .catch(error => console.warn('Could not save mesh peer keys:', error));
    return true;
  }

  async function handleMeshAnnouncement(packet, sourceEndpointId) {
    const hopsLeft = Number(packet.hopsLeft);
    if (!Number.isInteger(hopsLeft) || hopsLeft < 0 || hopsLeft > MAX_MESH_HOPS) return;
    const peer = verifyIdentityAnnouncement(packet);
    if (!peer || peer.id === profileIdRef.current) return;
    const expectedPeerId = hopsLeft === MAX_MESH_HOPS
      ? expectedPeerByEndpointRef.current.get(sourceEndpointId)
      : null;
    if (expectedPeerId && expectedPeerId !== peer.id) {
      expectedPeerByEndpointRef.current.delete(sourceEndpointId);
      nearby.disconnect(sourceEndpointId).catch(error => {
        console.warn('Could not disconnect a device with a mismatched identity:', error);
      });
      setNotice('This device did not match its saved identity and was disconnected.');
      return;
    }
    if (sourceEndpointId && hopsLeft === MAX_MESH_HOPS) {
      expectedPeerByEndpointRef.current.delete(sourceEndpointId);
    }
    if (!rememberMeshPeer(peer)) return;
    const firstSeen = !seenMeshPacketsRef.current.has(peer.id);
    seenMeshPacketsRef.current.set(peer.id, Date.now());

    if (sourceEndpointId) {
      peerByEndpointRef.current.set(sourceEndpointId, peer.id);
      setConnectedDevices(previous => previous.map(device => device.endpointId === sourceEndpointId
        ? { ...device, profileId: peer.id }
        : device));
      setChats(previous => previous.map(chat => chat.endpointId === sourceEndpointId
        ? { ...chat, profileId: peer.id }
        : chat));
    }

    if (firstSeen && sourceEndpointId && meshIdentityRef.current) {
      nearby.sendMessage(sourceEndpointId, createIdentityAnnouncement(meshIdentityRef.current, getPublicDisplayName()))
        .catch(error => console.warn('Could not reply to mesh identity announcement:', error));
    }

    if (firstSeen && hopsLeft > 0) {
      const forwarded = JSON.stringify({ ...packet, hopsLeft: hopsLeft - 1 });
      await Promise.allSettled(connectedDevicesRef.current
        .filter(device => device.endpointId !== sourceEndpointId)
        .map(device => nearby.sendMessage(device.endpointId, forwarded)));
    }
  }

  async function handleMeshEnvelope(packet, sourceEndpointId) {
    const hopsLeft = Number(packet.hopsLeft);
    if (!packet.id || typeof packet.recipientId !== 'string'
      || typeof packet.senderId !== 'string' || packet.ciphertext?.length > 24000
      || !Number.isInteger(hopsLeft) || hopsLeft < 0 || hopsLeft > MAX_MESH_HOPS) return;
    const sender = verifyMeshEnvelope(packet);
    if (!sender) return;
    const known = meshPeersRef.current.get(sender.id);
    if (known && (known.signingPublicKey !== sender.signingPublicKey
      || known.encryptionPublicKey !== sender.encryptionPublicKey)) return;
    rememberMeshPeer(sender);

    const now = Date.now();
    for (const [packetId, seenAt] of seenMeshPacketsRef.current) {
      if (now - seenAt > 10 * 60 * 1000) seenMeshPacketsRef.current.delete(packetId);
    }
    if (seenMeshPacketsRef.current.has(packet.id)) return;
    seenMeshPacketsRef.current.set(packet.id, now);
    if (seenMeshPacketsRef.current.size > 2000) {
      const oldest = seenMeshPacketsRef.current.keys().next().value;
      if (oldest) seenMeshPacketsRef.current.delete(oldest);
    }

    if (packet.recipientId === profileIdRef.current) {
      const plaintext = decryptMeshMessage(packet, sender, meshIdentityRef.current);
      if (!plaintext || !meshIdentityRef.current) return;
      if (plaintext.type === 'group-message') {
        saveGroupMessage(plaintext);
        return;
      }
      if (plaintext.type !== 'direct-message' || typeof plaintext.message?.text !== 'string') return;
      const incoming = {
        ...plaintext.message,
        sender: 'them',
        senderId: sender.id,
        status: 'received',
      };
      const directSource = connectedDevicesRef.current.find(device =>
        device.endpointId === sourceEndpointId && device.profileId === sender.id
      );
      const name = incoming.senderName || directSource?.name || `Nearby-${sender.id.slice(0, 6)}`;
      const activeChatMatches = selectedChatRef.current?.profileId === sender.id
        || selectedChatRef.current?.endpointId === directSource?.endpointId;
      saveOrUpdateChat({ endpointId: directSource?.endpointId, profileId: sender.id, name }, chat => {
        const isNewMessage = !(chat.messages || []).some(item => item.id === incoming.id);
        return {
          ...chat,
          profileId: sender.id,
          name,
          initials: getInitials(name),
          messages: isNewMessage ? [...(chat.messages || []), incoming] : chat.messages,
          message: incoming.text,
          time: new Date(incoming.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          unread: !isNewMessage || activeChatMatches ? 0 : (chat.unread || 0) + 1,
          updatedAt: incoming.sentAt || Date.now(),
        };
      });
      setNotice(`Encrypted message from ${name}`);
      return;
    }

    if (hopsLeft <= 0) return;
    const forwarded = JSON.stringify({ ...packet, hopsLeft: hopsLeft - 1 });
    await Promise.allSettled(connectedDevicesRef.current
      .filter(device => device.endpointId !== sourceEndpointId)
      .map(device => nearby.sendMessage(device.endpointId, forwarded)));
  }

  async function persistProfileName(name) {
    const savedName = name.trim() || getGeneratedDisplayName(profileIdRef.current);
    setProfileName(savedName);
    profileNameDirtyRef.current = false;
    await AsyncStorage.setItem('@chathub/profile-name', savedName);

    if (scanningRef.current) {
      await nearby.stopAdvertising();
      await nearby.startAdvertising(getNearbyEndpointName(savedName));
    }
    if (meshIdentityRef.current) {
      await Promise.allSettled(connectedDevicesRef.current.map(device =>
        nearby.sendMessage(device.endpointId, createIdentityAnnouncement(
          meshIdentityRef.current,
          getPublicDisplayName(savedName)
        ))
      ));
    }
    return savedName;
  }

  async function finishProfileSetup(name) {
    try {
      const savedName = await persistProfileName(name);
      setIsProfileSetupVisible(false);
      setNotice(`Profile saved as ${savedName}`);
    } catch (error) {
      console.warn('Could not save profile:', error);
      setNotice('Could not save profile. Please try again.');
    }
  }

  function saveOrUpdateChat(device, updateFn) {
    const id = device?.endpointId || device?.profileId;
    if (!id) return;
    setChats(previous => {
      const existing = previous.find(chat => (device.endpointId && chat.endpointId === device.endpointId)
        || (device.profileId && chat.profileId === device.profileId));
      if (existing) {
        return previous.map(chat => chat.endpointId === id
          ? updateFn({ ...existing })
          : chat
        ).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }
      const name = device.name || device.endpointName || 'Nearby device';
      const initial = {
        id,
        endpointId: device.endpointId,
        profileId: device.profileId,
        name,
        initials: getInitials(name),
        color: device.color || '#617848',
        online: connectedDevices.some(item => item.endpointId === id),
        messages: [],
        message: 'No messages yet',
        time: '',
        unread: 0,
        updatedAt: Date.now(),
      };
      return [updateFn(initial)].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });
  }

  function saveGroupMessage(payload) {
    const groupId = payload.groupId;
    const senderName = payload.senderName || 'Nearby device';
    const sentAt = Number(payload.sentAt) || Date.now();
    if (typeof groupId !== 'string' || !groupId) return;

    const message = {
      id: payload.id || `group-${sentAt}-${Math.random()}`,
      text: typeof payload.text === 'string' ? payload.text : '',
      sentAt,
      senderId: payload.senderId || '',
      sender: 'them',
      senderName,
      status: 'received',
    };
    const receivedMembers = Array.isArray(payload.memberNames)
      ? payload.memberNames.filter(member => typeof member === 'string' && member.trim())
      : [];
    const memberNames = [...new Set([...receivedMembers, senderName])];
    const receivedMemberIds = Array.isArray(payload.memberIds)
      ? payload.memberIds.map(profileKey).filter(Boolean)
      : [];
    const memberIds = [...new Set([...receivedMemberIds, profileKey(payload.senderId)])];

    setChats(previous => {
      const existing = previous.find(chat => chat.kind === 'group' && chat.id === groupId);
      const isNewMessage = !(existing?.messages || []).some(item => item.id === message.id);
      const messages = isNewMessage
        ? [...(existing?.messages || []), message]
        : existing.messages;
      const groupChat = {
        ...existing,
        id: groupId,
        kind: 'group',
        name: payload.groupName || existing?.name || 'Group chat',
        initials: getInitials(payload.groupName || existing?.name || 'Group chat'),
        color: existing?.color || '#617848',
        memberNames: [...new Set([...(existing?.memberNames || []), ...memberNames])],
        memberIds: [...new Set([...(existing?.memberIds || []), ...memberIds])],
        messages,
        message: message.text,
        time: new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        unread: !isNewMessage || selectedChatRef.current?.id === groupId
          ? 0
          : (existing?.unread || 0) + 1,
        updatedAt: sentAt,
      };

      return existing
        ? previous.map(chat => chat.id === groupId && chat.kind === 'group' ? groupChat : chat)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        : [groupChat, ...previous].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });
    setNotice(`New group message from ${senderName}`);
  }

  function getDeviceName(endpointId, fallback = 'Nearby device') {
    return connectedDevices.find(item => item.endpointId === endpointId)?.name
      || nearbyDevices.find(item => item.endpointId === endpointId)?.name
      || requests.find(item => item.endpointId === endpointId)?.name
      || chats.find(item => item.endpointId === endpointId)?.name
      || fallback;
  }

  function normalizeDeviceName(name = '') {
    return name.trim().toLowerCase();
  }

  function isBlockedDevice(name) {
    return blockedDevicesRef.current.has(normalizeDeviceName(name));
  }

  function saveBlockedDevices(nextBlockedDevices) {
    blockedDevicesRef.current = nextBlockedDevices;
    const saved = [...nextBlockedDevices.values()];
    setBlockedDevices(saved);
    AsyncStorage.setItem('@chathub/blocked-devices', JSON.stringify(saved))
      .catch(error => console.warn('Could not save blocked devices:', error));
  }

  function blockDevice(endpointId, name, requestPending = false) {
    if (!blockedDevicesLoadedRef.current) {
      setNotice('Block list is still loading. Try again shortly.');
      return;
    }

    const normalizedName = normalizeDeviceName(name);
    if (!normalizedName) return;

    const nextBlockedDevices = new Map(blockedDevicesRef.current);
    nextBlockedDevices.set(normalizedName, { endpointId, name: name.trim() });
    saveBlockedDevices(nextBlockedDevices);
    setNearbyDevices(previous => previous.filter(device =>
      normalizeDeviceName(device.name || device.endpointName) !== normalizedName
    ));
    setRequests(previous => previous.filter(request =>
      normalizeDeviceName(request.name) !== normalizedName
    ));

    if (requestPending) {
      nearby.rejectConnection(endpointId).catch(error => {
        console.warn('Could not reject blocked connection request:', error);
      });
    }
    setNotice(`${name} blocked on this phone`);
  }

  function unblockDevice(name) {
    const nextBlockedDevices = new Map(blockedDevicesRef.current);
    nextBlockedDevices.delete(normalizeDeviceName(name));
    saveBlockedDevices(nextBlockedDevices);
    setNotice(`${name} unblocked`);
  }

  useEffect(() => {
    let subscriptions = [];
    let mounted = true;
    let savedChats = [];

    AsyncStorage.getItem('@chathub/chats')
      .then(raw => {
        if (!mounted || !raw) return;
        try {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved)) savedChats = saved;
        } catch (error) {
          console.warn('Could not restore chat history:', error);
        }
      })
      .catch(error => console.warn('Could not load chat history:', error))
      .finally(() => {
        if (!mounted) return;
        setChats(previous => mergeRestoredChats(savedChats, previous));
        chatsLoadedRef.current = true;
      });

    const initializeNearby = async () => {
      try {
        subscriptions.push(
          nearby.addListener('deviceFound', device => {
            const endpointName = device.endpointName || device.name || 'Nearby device';
            const name = getEndpointDisplayName(endpointName);
            if (isBlockedDevice(name)) return;
            setNearbyDevices(previous => {
              const exists = previous.some(item => item.endpointId === device.endpointId);
              const normalized = { ...device, name };
              return exists
                ? previous.map(item => item.endpointId === device.endpointId ? { ...item, ...normalized } : item)
                : [...previous, normalized];
            });
          })
        );

        subscriptions.push(
          nearby.addListener('deviceLost', device => {
            setNearbyDevices(previous => previous.filter(item => item.endpointId !== device.endpointId));
          })
        );

        subscriptions.push(
          nearby.addListener('connectionRequest', request => {
            const endpointName = request.endpointName || request.name || 'Nearby device';
            const name = getEndpointDisplayName(endpointName);
            if (isBlockedDevice(name)) {
              nearby.rejectConnection(request.endpointId).catch(error => {
                console.warn('Could not reject blocked connection request:', error);
              });
              return;
            }
            const advertisedPeerId = getEndpointPeerId(endpointName);
            if (advertisedPeerId) {
              expectedPeerByEndpointRef.current.set(request.endpointId, advertisedPeerId);
              if (meshPeersRef.current.has(advertisedPeerId)) {
                nearby.acceptConnection(request.endpointId).then(() => {
                  setNotice(`Reconnecting to verified device ${name}…`);
                }).catch(error => {
                  expectedPeerByEndpointRef.current.delete(request.endpointId);
                  console.warn('Could not auto-accept a verified device:', error);
                  setNotice(`Could not reconnect to ${name}. Try again nearby.`);
                });
                return;
              }
            }
            setRequests(previous => {
              const pendingRequest = {
                id: request.endpointId,
                endpointId: request.endpointId,
                name,
                initials: getInitials(name),
                detail: advertisedPeerId
                  ? 'New device · compare the verification code before accepting.'
                  : 'Compare this code with the other device before accepting.',
                authenticationToken: request.authenticationToken,
                isOutgoing: Boolean(request.isOutgoing),
                color: '#7558A6',
              };
              return previous.some(item => item.endpointId === request.endpointId)
                ? previous.map(item => item.endpointId === request.endpointId ? pendingRequest : item)
                : [...previous, pendingRequest];
            });
          })
        );

        subscriptions.push(
          nearby.addListener('connectionChanged', event => {
            const status = String(event.status || '').toLowerCase();
            const name = getEndpointDisplayName(event.endpointName || event.name || getDeviceName(event.endpointId, 'Connected device'));
            if (status === 'connected') {
              const device = {
                endpointId: event.endpointId,
                name,
                profileId: peerByEndpointRef.current.get(event.endpointId),
                initials: getInitials(name),
                color: '#617848',
              };
              setConnectedDevices(previous => previous.some(item => item.endpointId === event.endpointId)
                ? previous.map(item => item.endpointId === event.endpointId ? { ...item, ...device } : item)
                : [...previous, device]);
              setRequests(previous => previous.filter(item => item.endpointId !== event.endpointId));
              saveOrUpdateChat(device, chat => ({ ...chat, name, initials: getInitials(name), online: true, updatedAt: Date.now() }));
              if (meshIdentityRef.current) {
                nearby.sendMessage(event.endpointId, createIdentityAnnouncement(meshIdentityRef.current, getPublicDisplayName()))
                  .catch(error => console.warn('Could not announce secure mesh identity:', error));
              }
              meshPeersRef.current.forEach(peer => {
                if (peer.announcement) {
                  try {
                    const announcement = JSON.parse(peer.announcement);
                    nearby.sendMessage(event.endpointId, JSON.stringify({ ...announcement, hopsLeft: 1 }))
                      .catch(error => console.warn('Could not share mesh peer identity:', error));
                  } catch (error) {
                    console.warn('Could not restore mesh identity announcement:', error);
                  }
                }
              });
              setNotice(`${name} connected successfully`);
            } else if (['disconnected', 'failed', 'rejected'].includes(status)) {
              setConnectedDevices(previous => previous.filter(item => item.endpointId !== event.endpointId));
              setChats(previous => previous.map(chat => chat.endpointId === event.endpointId ? { ...chat, online: false } : chat));
              if (status === 'failed') setNotice(`Connection to ${name} failed`);
              if (status === 'disconnected') setNotice(`${name} disconnected`);
            }
          })
        );

        subscriptions.push(
          nearby.addListener('messageReceived', async event => {
            const rawMessage = event.message;
            if (typeof rawMessage !== 'string') return;
            let payload;
            try {
              payload = JSON.parse(rawMessage);
            } catch {
              setNotice('An unencrypted message from an older app was ignored.');
              return;
            }
            if (payload.type === 'mesh-hello') {
              await handleMeshAnnouncement(payload, event.endpointId);
              return;
            }
            if (payload.type === 'mesh-envelope') {
              await handleMeshEnvelope(payload, event.endpointId);
              return;
            }
            if (payload.type === 'group-message') {
              setNotice('An unencrypted group message was ignored.');
              return;
            }
            setNotice('Unsupported or unencrypted message was ignored.');
          })
        );

        subscriptions.push(
          nearby.addListener('fileReceived', async event => {
            const endpointId = event.endpointId;
            const name = event.endpointName || getDeviceName(endpointId, 'Nearby device');
            let persistentUri = event.uri;
            if (event.uri) {
              try {
                const directory = `${FileSystem.documentDirectory}received-files/`;
                await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
                const extension = String(event.fileName || '').match(/\.([a-z0-9]{1,10})$/i)?.[1] || 'bin';
                const safeExtension = extension.toLowerCase();
                persistentUri = `${directory}${Crypto.randomUUID()}.${safeExtension}`;
                await FileSystem.copyAsync({ from: event.uri, to: persistentUri });
              } catch (error) {
                console.warn('Could not preserve received file:', error);
              }
            }
            const message = {
              id: event.messageId || `file-${event.payloadId}`,
              payloadId: event.payloadId,
              senderId: event.senderId || '',
              type: event.kind || 'file',
              name: event.fileName || 'Shared file',
              mimeType: event.mimeType || 'application/octet-stream',
              uri: persistentUri,
              sentAt: Number(event.sentAt) || Date.now(),
              sender: 'them',
              senderName: event.senderName || name,
              status: 'received',
            };
            saveOrUpdateChat({ endpointId, name }, chat => {
              const isNewMessage = !(chat.messages || []).some(item => item.id === message.id);
              const messages = isNewMessage ? [...(chat.messages || []), message] : chat.messages;
              return {
                ...chat,
                name,
                initials: getInitials(name),
                messages,
                message: message.type === 'audio' ? 'Voice message' : message.name,
                time: new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                unread: !isNewMessage || selectedChatRef.current?.endpointId === endpointId
                  ? 0
                  : (chat.unread || 0) + 1,
                updatedAt: message.sentAt,
              };
            });
            setNotice(`Received ${message.name} from ${name}`);
          })
        );

        subscriptions.push(
          nearby.addListener('transferComplete', event => {
            if (!event.messageId) return;
            setChats(previous => previous.map(chat => ({
              ...chat,
              messages: (chat.messages || []).map(message => message.id === event.messageId
                ? { ...message, status: 'sent' }
                : message
              ),
            })));
          })
        );

        subscriptions.push(
          nearby.addListener('transferFailed', event => {
            if (!event.messageId) return;
            setChats(previous => previous.map(chat => ({
              ...chat,
              messages: (chat.messages || []).map(message => message.id === event.messageId
                ? { ...message, status: 'failed' }
                : message
              ),
            })));
            setNotice('File transfer failed. Check the connection and retry.');
          })
        );

        subscriptions.push(
          nearby.addListener('fileTransferFailed', event => {
            setNotice(event.message || 'Could not save the received file.');
          })
        );
      } catch (error) {
        console.warn('Nearby initialization failed:', error);
      }
    };

    initializeNearby();

    return () => {
      mounted = false;
      subscriptions.forEach(subscription => {
        try { subscription?.remove?.(); } catch (error) {
          console.warn('Listener cleanup failed:', error);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (!chatsLoadedRef.current) return;
    AsyncStorage.setItem('@chathub/chats', JSON.stringify(chats))
      .catch(error => console.warn('Could not save chat history:', error));
  }, [chats]);

  useEffect(() => {
    let mounted = true;

    const loadProfileIdentity = async () => {
      let savedName = '';
      try {
        const [storedName, storedPeers, storedProfileId, storedLegacyProfileId] = await Promise.all([
          AsyncStorage.getItem('@chathub/profile-name'),
          AsyncStorage.getItem('@chathub/mesh-peers'),
          AsyncStorage.getItem('@chathub/profile-id'),
          AsyncStorage.getItem('@chathub/legacy-profile-id'),
        ]);
        savedName = storedName || '';
        let savedPeers = [];
        try {
          savedPeers = storedPeers ? JSON.parse(storedPeers) : [];
        } catch (error) {
          console.warn('Could not restore encrypted mesh peers:', error);
        }
        if (Array.isArray(savedPeers)) {
          meshPeersRef.current = new Map(savedPeers.filter(peer => peer?.id && peer?.signingPublicKey && peer?.encryptionPublicKey)
            .map(peer => [peer.id, peer]));
        }
        const identity = await loadOrCreateMeshIdentity();
        meshIdentityRef.current = identity;
        legacyProfileIdRef.current = storedLegacyProfileId || storedProfileId || identity.id;
        profileIdRef.current = identity.id;
        setProfileId(identity.id);
        await AsyncStorage.setItem('@chathub/legacy-profile-id', legacyProfileIdRef.current);
        await AsyncStorage.setItem('@chathub/profile-id', identity.id);
        seenMeshPacketsRef.current.set(identity.id, Date.now());
        if (savedName.trim()) {
          setProfileName(savedName.trim());
        } else {
          setProfileName(getGeneratedDisplayName(identity.id));
          setProfileSetupName('');
          setIsProfileSetupVisible(true);
        }
        connectedDevicesRef.current.forEach(device => {
          const displayName = getPublicDisplayName(savedName || getGeneratedDisplayName(identity.id));
          nearby.sendMessage(device.endpointId, createIdentityAnnouncement(identity, displayName)).catch(error => {
            console.warn('Could not announce secure mesh identity:', error);
          });
        });
      } catch (error) {
        console.warn('Could not initialize encrypted mesh identity:', error);
        setNotice('Secure messaging could not start on this device.');
      }
      if (!mounted) return;
    };

    loadProfileIdentity();

    AsyncStorage.getItem('@chathub/blocked-devices')
      .then(raw => {
        if (!mounted || !raw) return;
        try {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved)) {
            const validDevices = saved.filter(device => typeof device?.name === 'string' && device.name.trim());
            blockedDevicesRef.current = new Map(
              validDevices.map(device => [normalizeDeviceName(device.name), device])
            );
            setBlockedDevices([...blockedDevicesRef.current.values()]);
          }
        } catch (error) {
          console.warn('Could not restore blocked devices:', error);
        }
      })
      .catch(error => console.warn('Could not load blocked devices:', error))
      .finally(() => {
        blockedDevicesLoadedRef.current = true;
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedChat) {
        closeChat();
        return true;
      }

      if (isEditingProfile) {
        setIsEditingProfile(false);
        return true;
      }

      if (activeTab !== 'Home') {
        setActiveTab('Home');
        setSearchQuery('');
        lastBackPressRef.current = 0;
        return true;
      }

      const now = Date.now();
      if (now - lastBackPressRef.current < 2000) {
        BackHandler.exitApp();
      } else {
        lastBackPressRef.current = now;
        ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
      }
      return true;
    });

    return () => subscription.remove();
  }, [activeTab, isEditingProfile, selectedChat]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setNotice('');
    }, 3000);

    return () => clearTimeout(timer);
  }, [notice]);

  function getInitials(name = '') {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part.charAt(0).toUpperCase())
      .join('');
  }

  const filteredDevices = nearbyDevices.filter(device =>
    (device.name || device.endpointName || 'Nearby device')
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  );

  async function startScanning() {
  // Prevent duplicate scan requests immediately
  if (scanningRef.current) {
    return;
  }

  if (!blockedDevicesLoadedRef.current) {
    setNotice('Loading blocked devices. Try scanning again shortly.');
    return;
  }

  if (!profileIdRef.current) {
    setNotice('Setting up your profile. Try scanning again shortly.');
    return;
  }

  scanningRef.current = true;
  setNotice('Searching for nearby devices...');

  try {
    const available = await nearby.isAvailable();

    if (!available) {
      throw new Error('Nearby Connections is not available.');
    }

    if (Platform.OS === 'android') {
      const granted = await requestNearbyPermissions();

if (!granted) {
  setIsScanning(false);
  scanningRef.current = false;
  setNotice('Nearby permissions are required to scan.');
  return;
}
    }

    await nearby.startDiscovery();
    setIsScanning(true);

    let advertisingStarted = true;
    try {
      await nearby.startAdvertising(getNearbyEndpointName());
    } catch (advertisingError) {
      console.warn('Advertising start error:', advertisingError);

      // Discovery may still be running, but this phone will not be discoverable.
      advertisingStarted = false;
      setNotice('Search started, but other phones may not discover this device.');

    }

    if (advertisingStarted) {
      setNotice('Searching for nearby devices...');
    }
    if (Platform.OS === 'android') {
      nearby.playScanStartSound().catch(error => {
        console.warn('Could not play scan-start sound:', error);
      });
    }
  } catch (error) {
    console.warn('Start scanning error:', error);

    scanningRef.current = false;
    setIsScanning(false);

    setNotice(
      'Could not start nearby search. Stop scanning and try again.'
    );
  }
}

  async function openQrScanner() {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        setNotice('Camera permission is needed to scan a connection QR.');
        return;
      }
    }
    qrScanHandledRef.current = false;
    setIsCameraReady(false);
    setCameraMountError('');
    setIsQrScannerOpen(true);
  }

  function handleConnectionQrScanned({ data }) {
    if (qrScanHandledRef.current) return;
    qrScanHandledRef.current = true;
    try {
      const packet = JSON.parse(data);
      const peer = verifyIdentityAnnouncement(packet);
      if (!peer || peer.id === profileIdRef.current) {
        throw new Error('This QR is not a valid ChatHub connection code.');
      }
      if (!rememberMeshPeer(peer)) {
        throw new Error('This QR conflicts with a previously saved identity.');
      }
      const name = peer.name || `ChatHub-${peer.id.slice(0, 6)}`;
      setChats(previous => {
        const existing = previous.find(chat => chat.profileId === peer.id);
        if (existing) return previous;
        return [{
          id: peer.id,
          profileId: peer.id,
          name,
          initials: getInitials(name),
          color: '#617848',
          online: false,
          messages: [],
          message: 'QR verified · connect nearby to chat',
          time: '',
          unread: 0,
          updatedAt: Date.now(),
        }, ...previous];
      });
      setIsQrScannerOpen(false);
      setNotice(`Verified ${name}. Searching nearby so you can connect.`);
      if (!scanningRef.current) startScanning();
    } catch (error) {
      qrScanHandledRef.current = false;
      setNotice(error.message || 'Could not read this ChatHub connection QR.');
    }
  }

  function getConnectionQrValue() {
    if (!meshIdentityRef.current) return '';
    return createIdentityAnnouncement(
      meshIdentityRef.current,
      getPublicDisplayName(),
      0
    );
  }

  async function stopScanning() {
  try {
    await nearby.stopDiscovery();
    await nearby.stopAdvertising();

    setNearbyDevices([]);
    setNotice('Nearby search stopped.');
  } catch (error) {
    console.warn('Stop scanning error:', error);
    setNotice('Could not completely stop nearby search.');
  } finally {
    scanningRef.current = false;
    setIsScanning(false);
  }
}
  async function connectToDevice(device) {
    try {
      if (!profileIdRef.current) {
        setNotice('Setting up your profile. Try connecting again shortly.');
        return;
      }
      if (!device?.endpointId) {
        setNotice('Device ID is missing');
        return;
      }

      const deviceName = device.name || device.endpointName || 'Nearby device';
      await nearby.requestConnection(device.endpointId, getNearbyEndpointName());
      saveOrUpdateChat({ ...device, name: deviceName }, chat => ({
        ...chat, name: deviceName, initials: getInitials(deviceName), updatedAt: Date.now()
      }));
      setNotice(`Connection request sent to ${deviceName}`);
    } catch (error) {
      setNotice('Could not send connection request');
      console.warn('Connection request error:', error);
    }
  }

  async function acceptRequest(request) {
    if (!request.authenticationToken) {
      setNotice('Verification code is unavailable. Do not accept this connection.');
      return;
    }

    try {
      await nearby.acceptConnection(request.endpointId);

      setRequests(previous =>
        previous.filter(item => item.id !== request.id)
      );

      setNotice(`Accepting ${request.name}'s request...`);
    } catch (error) {
      setNotice('Could not accept connection');
      console.warn('Accept connection error:', error);
    }
  }

  async function rejectRequest(request) {
    try {
      await nearby.rejectConnection(request.endpointId);

      setRequests(previous =>
        previous.filter(item => item.id !== request.id)
      );

      setNotice('Connection request rejected');
    } catch (error) {
      setNotice('Could not reject connection');
      console.warn('Reject connection error:', error);
    }
  }

  async function disconnectDevice(device) {
    try {
      await nearby.disconnect(device.endpointId);

      setConnectedDevices(previous =>
        previous.filter(
          item => item.endpointId !== device.endpointId
        )
      );

      setNotice(`${device.name} disconnected`);
    } catch (error) {
      setNotice('Could not disconnect device');
      console.warn('Disconnect error:', error);
    }
  }

  function openChat(chat) {
    if (chat.kind === 'group') {
      const latest = chats.find(item => item.kind === 'group' && item.id === chat.id) || chat;
      setSelectedChat(latest);
      setChats(previous => previous.map(item =>
        item.kind === 'group' && item.id === chat.id ? { ...item, unread: 0 } : item
      ));
      setMessageDraft('');
      return;
    }

    const latest = chats.find(item => (chat.profileId && item.profileId === chat.profileId)
      || (chat.endpointId && item.endpointId === chat.endpointId)) || chat;
    setSelectedChat(latest);
    setChats(previous => previous.map(item =>
      (chat.profileId && item.profileId === chat.profileId)
        || (chat.endpointId && item.endpointId === chat.endpointId)
        ? { ...item, unread: 0 }
        : item
    ));
    setMessageDraft('');
  }

  function closeChat() {
    if (isRecordingVoice) {
      setNotice('Stop the voice recording before leaving this chat.');
      return;
    }
    setSelectedChat(null);
    setMessageDraft('');
  }

  function getGroupRecipients(group) {
    const memberIds = new Set([
      ...(group.memberIds || []).map(profileKey),
      ...(group.memberNames || []).map(profileKeyFromName),
    ].filter(Boolean));
    const shortMemberIds = new Set([...memberIds].map(id => id.slice(0, 8)));
    const memberNames = new Set((group.memberNames || []).map(normalizeDeviceName));
    return connectedDevices.filter(device => {
      const deviceKey = profileKey(device.profileId);
      if (deviceKey && memberIds.has(deviceKey)) return true;
      const shortDeviceKey = profileKeyFromName(device.name);
      if (shortDeviceKey && shortMemberIds.has(shortDeviceKey)) return true;
      if (deviceKey || shortDeviceKey) return false;
      // Legacy peers without the public CH identity can only be matched by name.
      return memberNames.has(normalizeDeviceName(device.name));
    });
  }

  function getGroupMemberIds(group) {
    const ids = new Set((group.memberIds || []).map(profileKey).filter(id => id.length >= 32));
    const legacyNames = new Set((group.memberNames || []).map(normalizeDeviceName));
    meshPeersRef.current.forEach(peer => {
      if (peer.name && legacyNames.has(normalizeDeviceName(peer.name))) ids.add(peer.id);
    });
    connectedDevices.forEach(device => {
      if (device.profileId && legacyNames.has(normalizeDeviceName(device.name))) ids.add(profileKey(device.profileId));
    });
    return [...ids];
  }

  function createGroupChat() {
    const groupName = newGroupName.trim();
    const members = connectedDevices.filter(device => selectedGroupMembers.includes(device.endpointId));
    if (!groupName) {
      setNotice('Enter a name for the group.');
      return;
    }
    if (members.length === 0) {
      setNotice('Select at least one connected device.');
      return;
    }
    if (members.some(device => !device.profileId || !meshPeersRef.current.has(device.profileId))) {
      setNotice('Wait for each device to finish secure identity exchange, then try again.');
      return;
    }

    const memberNames = [...new Set([getPublicDisplayName(), ...members.map(device => device.name)])];
    const memberIds = [...new Set([profileKey(profileId), ...members.map(device =>
      profileKey(device.profileId)
    ).filter(Boolean)])];
    const group = {
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'group',
      name: groupName,
      initials: getInitials(groupName),
      color: '#617848',
      memberNames,
      memberIds,
      messages: [],
      message: `${memberNames.length} members`,
      time: '',
      unread: 0,
      updatedAt: Date.now(),
    };
    setChats(previous => [group, ...previous]);
    setIsGroupModalOpen(false);
    setNewGroupName('');
    setSelectedGroupMembers([]);
    setSelectedChat(group);
    setMessageDraft('');
    setNotice(`Group ${groupName} created`);
  }

  async function transmitGroupMessage(group, message) {
    const recipientIds = [...new Set(getGroupMemberIds(group))]
      .filter(id => id && id !== profileKey(profileId));
    const neighbors = connectedDevicesRef.current;
    if (recipientIds.length === 0 || neighbors.length === 0) {
      setNotice('Connect to at least one mesh device before sending.');
      return false;
    }
    try {
      const missingKeys = recipientIds.filter(id => !meshPeersRef.current.has(id));
      if (missingKeys.length) throw new Error('Secure key missing for one or more group members');
      const payload = {
        type: 'group-message',
        groupId: group.id,
        groupName: group.name,
        memberNames: group.memberNames,
        memberIds: [...new Set(recipientIds.concat(profileKey(profileId)))],
        id: message.id,
        text: message.text,
        sentAt: message.sentAt,
        senderName: message.senderName || getPublicDisplayName(),
        senderId: message.senderId || profileId,
      };
      const attempts = recipientIds.flatMap(recipientId => {
        const envelope = encryptMeshMessage(meshIdentityRef.current, meshPeersRef.current.get(recipientId), payload, 'group-message');
        return neighbors.map(device => nearby.sendMessage(device.endpointId, envelope));
      });
      const results = await Promise.allSettled(attempts);
      const succeeded = new Set();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') succeeded.add(recipientIds[Math.floor(index / neighbors.length)]);
      });
      const status = succeeded.size === recipientIds.length ? 'sent' : succeeded.size > 0 ? 'partial' : 'failed';
      setChats(previous => previous.map(chat => chat.kind === 'group' && chat.id === group.id
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status } : item) }
        : chat
      ));
      if (status !== 'sent') {
        setNotice(status === 'partial'
          ? `Message was forwarded toward ${succeeded.size} of ${recipientIds.length} group members.`
          : 'Message could not be sent to the group.');
      }
      return status !== 'failed';
    } catch (error) {
      console.warn('Group message send failed:', error);
      setChats(previous => previous.map(chat => chat.kind === 'group' && chat.id === group.id
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'failed' } : item) }
        : chat
      ));
      setNotice('Message could not be sent to the group.');
      return false;
    }
  }

  async function sendGroupChatMessage(text) {
    const group = chats.find(item => item.kind === 'group' && item.id === selectedChat?.id) || selectedChat;
    if (connectedDevicesRef.current.length === 0) {
      setNotice('Connect to at least one mesh device before sending.');
      return;
    }

    const sentAt = Date.now();
    const message = {
      id: `${sentAt}-${Math.random().toString(36).slice(2, 9)}`,
      text,
      sentAt,
      sender: 'me',
      senderName: getPublicDisplayName(),
      senderId: profileId,
      status: 'sending',
    };
    setMessageDraft('');
    setChats(previous => previous.map(chat => chat.kind === 'group' && chat.id === group.id
      ? {
          ...chat,
          messages: [...(chat.messages || []), message],
          message: text,
          time: new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          updatedAt: sentAt,
        }
      : chat
    ));

    await transmitGroupMessage(group, message);
  }

  async function transmitChatMessage(targetId, message) {
    const targetProfileId = profileKey(targetId)
      || chats.find(chat => chat.endpointId === targetId)?.profileId
      || connectedDevices.find(device => device.endpointId === targetId)?.profileId;
    const recipient = meshPeersRef.current.get(targetProfileId);
    const neighbors = connectedDevicesRef.current;
    if (!targetProfileId || !recipient || neighbors.length === 0 || !meshIdentityRef.current) {
      if (targetProfileId) {
        setChats(previous => previous.map(chat => chat.profileId === targetProfileId || chat.endpointId === targetId
          ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'failed' } : item) }
          : chat
        ));
      }
      setNotice('Secure route unavailable. Connect nearby devices and wait for key exchange.');
      return;
    }

    setChats(previous => previous.map(chat => chat.profileId === targetProfileId || chat.endpointId === targetId
      ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'sending' } : item) }
      : chat
    ));

    try {
      const envelope = encryptMeshMessage(meshIdentityRef.current, recipient, {
        type: 'direct-message',
        message: {
          ...message,
          senderName: message.senderName || getPublicDisplayName(),
          senderId: message.senderId || profileId,
        },
      });
      const results = await Promise.allSettled(neighbors.map(device => nearby.sendMessage(device.endpointId, envelope)));
      if (!results.some(result => result.status === 'fulfilled')) throw new Error('No mesh neighbor accepted the message');
      setChats(previous => previous.map(chat => chat.profileId === targetProfileId || chat.endpointId === targetId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'sent' } : item) }
        : chat
      ));
    } catch (error) {
      console.warn('Message send failed:', error);
      setChats(previous => previous.map(chat => chat.profileId === targetProfileId || chat.endpointId === targetId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'failed' } : item) }
        : chat
      ));
      setNotice('Message could not be sent. Check the connection and retry.');
    }
  }

  async function transmitChatFile(endpointId, message) {
    const connected = connectedDevices.some(device => device.endpointId === endpointId);
    if (!connected || !message.uri) {
      setNotice(connected ? 'This file is no longer available to retry.' : 'Reconnect before retrying this file.');
      return;
    }

    setChats(previous => previous.map(chat => chat.endpointId === endpointId
      ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'sending' } : item) }
      : chat
    ));

    try {
      const payloadId = await nearby.sendFile(
        endpointId,
        message.uri,
        message.id,
        message.name,
        message.mimeType || 'application/octet-stream',
        message.type,
        message.sentAt,
        message.senderName || getPublicDisplayName(),
        message.senderId || profileId
      );
      setChats(previous => previous.map(chat => chat.endpointId === endpointId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, payloadId } : item) }
        : chat
      ));
    } catch (error) {
      console.warn('File transfer failed:', error);
      setChats(previous => previous.map(chat => chat.endpointId === endpointId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'failed' } : item) }
        : chat
      ));
      setNotice(error?.code === 'FILE_TOO_LARGE'
        ? 'Files must be 100 MB or smaller.'
        : 'File transfer failed. Check the connection and retry.');
    }
  }

  async function sendChatAttachment(attachment) {
    const endpointId = selectedChat?.endpointId;
    if (!endpointId || !connectedDevices.some(device => device.endpointId === endpointId)) {
      setNotice('Connect to this device before sending attachments.');
      return;
    }

    const sentAt = Date.now();
    const message = {
      id: `${sentAt}-${Math.random().toString(36).slice(2, 9)}`,
      ...attachment,
      sentAt,
      sender: 'me',
      senderName: getPublicDisplayName(),
      senderId: profileId,
      status: 'sending',
    };
    setChats(previous => previous.map(chat => chat.endpointId === endpointId
      ? {
          ...chat,
          messages: [...(chat.messages || []), message],
          message: message.type === 'audio' ? 'Voice message' : message.name,
          time: new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          unread: 0,
          updatedAt: sentAt,
        }
      : chat
    ));
    await transmitChatFile(endpointId, message);
  }

  async function pickChatFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: '*/*',
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      if ((asset.size || 0) > 100 * 1024 * 1024) {
        setNotice('Choose a file that is 100 MB or smaller.');
        return;
      }

      await sendChatAttachment({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType || 'application/octet-stream',
        type: asset.mimeType?.startsWith('image/') ? 'image' : 'file',
      });
    } catch (error) {
      console.warn('Could not select file:', error);
      setNotice('Could not open the file picker.');
    }
  }

  async function toggleVoiceRecording() {
    if (isRecordingVoice) {
      try {
        await audioRecorder.stop();
        setIsRecordingVoice(false);
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        const uri = audioRecorder.uri;
        if (!uri) {
          setNotice('Voice recording was not saved.');
          return;
        }
        const fileName = uri.split('/').pop() || `voice-${Date.now()}.m4a`;
        const mimeType = fileName.toLowerCase().endsWith('.3gp') ? 'audio/3gpp' : 'audio/mp4';
        await sendChatAttachment({ uri, name: fileName, mimeType, type: 'audio' });
      } catch (error) {
        console.warn('Could not finish voice recording:', error);
        setIsRecordingVoice(false);
        setNotice('Could not finish voice recording.');
      }
      return;
    }

    if (!selectedChat?.endpointId || !connectedDevices.some(device => device.endpointId === selectedChat.endpointId)) {
      setNotice('Connect to this device before recording a voice message.');
      return;
    }

    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setNotice('Microphone permission is required for voice messages.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecordingVoice(true);
    } catch (error) {
      console.warn('Could not start voice recording:', error);
      setNotice('Could not start voice recording. Check microphone permission.');
    }
  }

  async function shareChatFile(message) {
    if (!message.uri) {
      setNotice('This file is no longer available on this phone.');
      return;
    }
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setNotice('File sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(message.uri, {
        mimeType: message.mimeType,
        dialogTitle: message.name || 'Share file',
      });
    } catch (error) {
      console.warn('Could not share file:', error);
      setNotice('Could not open the system share menu.');
    }
  }

  function retryChatMessage(endpointId, message) {
    if (message.status === 'failed') {
      if (message.type && message.uri) {
        transmitChatFile(endpointId, message);
      } else {
        transmitChatMessage(endpointId, message);
      }
    }
  }

  function retryGroupMessage(group, message) {
    if (message.status === 'failed' || message.status === 'partial') {
      transmitGroupMessage(group, message);
    }
  }

  function deleteChatMessage(chat, messageId) {
    Alert.alert(
      'Delete this message?',
      'This removes it from this phone only. The other person may still have it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => setChats(previous => previous.map(item => {
            const matchesChat = chat.kind === 'group'
              ? item.kind === 'group' && item.id === chat.id
              : chat.profileId
                ? item.profileId === chat.profileId
                : Boolean(chat.endpointId) && item.endpointId === chat.endpointId;
            if (!matchesChat) return item;
            const messages = (item.messages || []).filter(message => message.id !== messageId);
            const latestMessage = messages[messages.length - 1];
            return {
              ...item,
              messages,
              message: latestMessage?.text || 'No messages yet',
              time: latestMessage
                ? new Date(latestMessage.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '',
              updatedAt: latestMessage?.sentAt || 0,
            };
          }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))),
        },
      ]
    );
  }

  async function sendChatMessage() {
    const text = messageDraft.trim();
    if (!text || !selectedChat) return;
    if (selectedChat.kind === 'group') {
      await sendGroupChatMessage(text);
      return;
    }
    const targetProfileId = selectedChat.profileId
      || connectedDevices.find(device => device.endpointId === selectedChat.endpointId)?.profileId;
    if (!targetProfileId || connectedDevicesRef.current.length === 0) {
      setNotice('Connect to a mesh device and wait for secure identity exchange.');
      return;
    }

    const sentAt = Date.now();
    const message = {
      id: `${sentAt}-${Math.random().toString(36).slice(2, 9)}`,
      text,
      sentAt,
      sender: 'me',
      senderName: getPublicDisplayName(),
      senderId: profileId,
      status: 'sending',
    };
    setMessageDraft('');
    setChats(previous => previous.map(chat => chat.profileId === targetProfileId
      || chat.endpointId === selectedChat.endpointId
      ? {
          ...chat,
          messages: [...(chat.messages || []), message],
          message: text,
          time: new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          unread: 0,
          updatedAt: sentAt,
        }
      : chat
    ));
    await transmitChatMessage(targetProfileId, message);
  }

  function renderHeader() {
    return (
      <View style={styles.header}>
        <View style={styles.brandContainer}>
          <View style={styles.brandIcon}>
            <Ionicons
              name="chatbubbles"
              size={24}
              color={COLORS.background}
            />
          </View>

          <View>
            <Text style={styles.brandTitle}>ChatHub</Text>
            <Text style={styles.brandSubtitle}>PRIVATE MESSAGING</Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <View style={styles.privacyBadge}>
            <Ionicons
              name="shield-checkmark"
              size={13}
              color={COLORS.green}
            />
            <Text style={styles.privacyBadgeText}>OFFLINE</Text>
          </View>

          <IconButton
            name="person-circle-outline"
            size={26}
            accessibilityLabel="Open profile"
            onPress={() => {
              setSelectedChat(null);
              setActiveTab('Profile');
              setSearchQuery('');
            }}
          />
        </View>
      </View>
    );
  }

  function renderGreeting() {
    const firstName = (profileName || 'there').trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    return (
      <View style={styles.greetingContainer}>
        <Text style={styles.greetingEyebrow}>{greeting}</Text>
        <Text style={styles.greetingTitle}>{firstName}</Text>
        <Text style={styles.greetingSubtitle}>Your private network at a glance</Text>
      </View>
    );
  }

  function renderScannerCard() {
    return (
      <View style={styles.scannerCard}>
        <View style={styles.scannerCardTop}>
          <View style={styles.scannerTextContainer}>
            <Text style={styles.scannerTitle}>
              Find people nearby
            </Text>
            <Text style={styles.scannerDescription}>
              {isScanning
                ? `${nearbyDevices.length} nearby ${nearbyDevices.length === 1 ? 'device' : 'devices'} found. Keep scanning to discover more.`
                : 'Connect with nearby ChatHub devices, privately.'}
            </Text>
          </View>

          <View style={styles.scannerVisual}>
            {isScanning ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.scannerPulseRing,
                  {
                    opacity: scanPulse.interpolate({
                      inputRange: [0, 0.78, 1],
                      outputRange: [0.65, 0.16, 0],
                    }),
                    transform: [{
                      scale: scanPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.68, 1.72],
                      }),
                    }],
                  },
                ]}
              />
            ) : null}
            <View style={styles.scannerCircleOuter}>
              <View style={styles.scannerCircleMiddle}>
                <View style={styles.scannerCircleInner}>
                  <Ionicons
                    name="radio"
                    size={28}
                    color={COLORS.background}
                  />
                </View>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.scannerDivider} />

        <View style={styles.scannerBottom}>
          <View style={styles.scannerStatus}>
            <Ionicons
              name={isScanning ? 'radio-outline' : 'shield-checkmark-outline'}
              size={17}
              color={isScanning ? COLORS.green : COLORS.muted}
            />

            <Text style={styles.scannerStatusText}>
              {isScanning ? 'Searching nearby' : 'Ready to connect'}
            </Text>
          </View>

          <View style={styles.scannerActionRow}>
            <TouchableOpacity
              style={[styles.scanButton, isScanning && styles.scanButtonActive]}
              accessibilityRole="button"
              accessibilityLabel={isScanning ? 'Stop nearby scan' : 'Start nearby scan'}
              onPress={isScanning ? stopScanning : startScanning}
              activeOpacity={0.8}
            >
              <Ionicons name={isScanning ? 'stop' : 'scan'} size={17} color={isScanning ? COLORS.text : COLORS.background} />
              <Text style={[styles.scanButtonText, isScanning && styles.scanButtonTextActive]}>
                {isScanning ? 'Stop scan' : 'Start scan'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  function renderConnectionQrCard() {
    return (
      <View style={styles.qrConnectCard}>
        <View style={styles.qrConnectHeading}>
          <View style={styles.qrConnectIcon}>
            <Ionicons name="qr-code-outline" size={20} color={COLORS.primary} />
          </View>
          <View style={styles.qrConnectCopy}>
            <Text style={styles.qrConnectTitle}>Connect with QR</Text>
          <Text style={styles.qrConnectDescription}>Verify someone once, then reconnect faster next time.</Text>
          </View>
        </View>
        <View style={styles.qrConnectActions}>
              <TouchableOpacity accessibilityRole="button" style={styles.qrActionButton} onPress={openQrScanner} activeOpacity={0.8}>
            <Ionicons name="scan-outline" size={17} color={COLORS.primary} />
            <Text style={styles.qrActionText}>Scan QR</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.qrActionButton}
            accessibilityRole="button"
            onPress={() => setIsMyQrOpen(true)}
            disabled={!meshIdentityRef.current}
            activeOpacity={0.8}
          >
            <Ionicons name="qr-code" size={17} color={COLORS.primary} />
            <Text style={styles.qrActionText}>Show my QR</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  function renderStats() {
    const stats = [
      {
        label: 'Nearby',
        value: String(nearbyDevices.length),
        icon: 'radio-outline',
        color: COLORS.cyan,
      },
      {
        label: 'Connected',
        value: String(connectedDevices.length),
        icon: 'link-outline',
        color: COLORS.mint,
      },
      {
        label: 'Chats',
        value: String(chats.length),
        icon: 'chatbubbles-outline',
        color: COLORS.blue,
      },
    ];

    return (
      <View style={styles.statsContainer}>
        {stats.map(stat => (
          <View
            key={stat.label}
            style={[
              styles.statCard,
              { backgroundColor: `${stat.color}0D`, borderColor: `${stat.color}30` },
            ]}
          >
            <View
              style={[
                styles.statIcon,
                { backgroundColor: `${stat.color}18` },
              ]}
            >
              <Ionicons
                name={stat.icon}
                size={19}
                color={stat.color}
              />
            </View>

            <Text style={styles.statValue}>{stat.value}</Text>
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
        ))}
      </View>
    );
  }

  function renderHomeQuickActions() {
    return (
      <View style={styles.homeQuickActions}>
        <TouchableOpacity
          style={styles.homeQuickAction}
          onPress={openQrScanner}
          accessibilityRole="button"
          accessibilityLabel="Scan a connection QR code"
          activeOpacity={0.8}
        >
          <View style={[styles.homeQuickIcon, { backgroundColor: 'rgba(98,216,232,0.12)' }]}>
            <Ionicons name="scan-outline" size={19} color={COLORS.cyan} />
          </View>
          <View style={styles.homeQuickCopy}>
            <Text style={styles.homeQuickTitle}>Scan QR</Text>
            <Text style={styles.homeQuickSubtitle}>Connect securely</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={COLORS.muted} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.homeQuickAction}
          onPress={() => setIsMyQrOpen(true)}
          disabled={!meshIdentityRef.current}
          accessibilityRole="button"
          accessibilityLabel="Show my connection QR code"
          activeOpacity={0.8}
        >
          <View style={[styles.homeQuickIcon, { backgroundColor: 'rgba(180,154,255,0.12)' }]}>
            <Ionicons name="qr-code-outline" size={19} color={COLORS.violet} />
          </View>
          <View style={styles.homeQuickCopy}>
            <Text style={styles.homeQuickTitle}>My QR</Text>
            <Text style={styles.homeQuickSubtitle}>Let others connect</Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={COLORS.muted} />
        </TouchableOpacity>
      </View>
    );
  }
    function renderHome() {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.screenContent}
      >
        {renderGreeting()}
        {renderScannerCard()}
        {renderHomeQuickActions()}
        {renderStats()}

        <SectionTitle
          title="Your connections"
          action="See all"
          onAction={() => setActiveTab('Nearby')}
        />

        {connectedDevices.length > 0 ? (
          connectedDevices.map(device => (
            <View key={device.endpointId} style={styles.deviceRow}>
              <Avatar
                initials={device.initials || getInitials(device.name)}
                color={device.color}
                online
              />

              <View style={styles.deviceInfo}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.deviceSubtitle}>Ready to chat nearby</Text>
              </View>

              <IconButton
                name="chatbubble-ellipses-outline"
                color={COLORS.primary}
                onPress={() =>
                  openChat({
                    ...device,
                    id: device.endpointId,
                  })
                }
              />
            </View>
          ))
        ) : (
          <View style={styles.compactEmptyCard}>
            <View style={styles.compactEmptyIcon}>
              <Ionicons
                name="phone-portrait-outline"
                size={22}
                color={COLORS.muted}
              />
            </View>

            <View style={styles.compactEmptyText}>
              <Text style={styles.compactEmptyTitle}>
                No connected devices yet
              </Text>
              <Text style={styles.compactEmptyDescription}>
                Find someone nearby to get started.
              </Text>
            </View>

            <IconButton
              name="arrow-forward"
              color={COLORS.primary}
              onPress={() => setActiveTab('Nearby')}
            />
          </View>
        )}

        {chats.length > 0 && (
          <>
            <SectionTitle
              title="Recent conversations"
              action="See all"
              onAction={() => setActiveTab('Chats')}
            />

            {chats.slice(0, 3).map(chat => (
              <TouchableOpacity
                key={chat.id}
                style={styles.chatRow}
                onPress={() => openChat(chat)}
                activeOpacity={0.75}
              >
                <Avatar
                  initials={chat.initials || getInitials(chat.name)}
                  color={chat.color}
                  online={chat.online}
                />
                <View style={styles.chatInfo}>
                  <View style={styles.chatNameRow}>
                    <Text style={styles.chatName} numberOfLines={1}>{chat.name}</Text>
                    <Text style={styles.chatTime}>{chat.time}</Text>
                  </View>
                  <View style={styles.chatPreviewRow}>
                    <Text style={styles.chatPreview} numberOfLines={1}>{chat.message}</Text>
                    {chat.unread > 0 ? (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadBadgeText}>{chat.unread > 99 ? '99+' : chat.unread}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

      </ScrollView>
    );
  }

  function renderSearchBar(placeholder = 'Search nearby devices...') {
    return (
      <View style={styles.searchBar}>
        <Ionicons
          name="search-outline"
          size={20}
          color={COLORS.muted}
        />

        <TextInput
          style={styles.searchInput}
          accessibilityLabel={placeholder}
          placeholder={placeholder}
          placeholderTextColor={COLORS.muted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          returnKeyType="search"
        />

        {searchQuery.length > 0 && (
          <IconButton
            name="close-circle"
            size={19}
            color={COLORS.muted}
            onPress={() => setSearchQuery('')}
          />
        )}
      </View>
    );
  }

  function renderNearby() {
    const radarSize = Math.min(windowWidth - 80, 320);
    const radarPositions = [
      { left: '20%', top: '23%' },
      { left: '68%', top: '28%' },
      { left: '73%', top: '64%' },
      { left: '26%', top: '72%' },
      { left: '47%', top: '13%' },
      { left: '12%', top: '48%' },
    ];

    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <View>
            <Text style={styles.pageTitle}>Nearby</Text>
            <Text style={styles.nearbyPageSubtitle}>Discover devices around you</Text>
          </View>
          <View style={[styles.statusPill, isScanning && styles.statusPillActive]}>
            <View style={[styles.statusPillDot, isScanning && styles.statusPillDotActive]} />
            <Text style={[styles.statusPillText, isScanning && styles.statusPillTextActive]}>
              {isScanning ? 'SCANNING' : 'READY'}
            </Text>
          </View>
        </View>

        <View style={styles.radarCard}>
          <View style={styles.radarHeading}>
            <View>
              <Text style={styles.radarTitle}>{isScanning ? 'Looking around' : 'Ready to discover'}</Text>
              <Text style={styles.radarSubtitle}>
                {filteredDevices.length > 0
                  ? `${filteredDevices.length} ${filteredDevices.length === 1 ? 'device' : 'devices'} in range`
                  : isScanning ? 'Keep ChatHub open to find nearby phones' : 'Start scanning to find nearby phones'}
              </Text>
            </View>
            <View style={styles.radarSignalIcon}>
              <Ionicons name="wifi-outline" size={20} color={COLORS.primary} />
            </View>
          </View>

          <View style={[styles.radarCanvas, { width: radarSize, height: radarSize }]}>
            <View style={[styles.radarRing, styles.radarRingOuter]} />
            <View style={[styles.radarRing, styles.radarRingMiddle]} />
            <View style={[styles.radarRing, styles.radarRingInner]} />
            <View style={styles.radarCrosshairVertical} />
            <View style={styles.radarCrosshairHorizontal} />
            {isScanning ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.radarPulseRing,
                  {
                    opacity: scanPulse.interpolate({
                      inputRange: [0, 0.7, 1],
                      outputRange: [0.7, 0.2, 0],
                    }),
                    transform: [{
                      scale: scanPulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1.1] }),
                    }],
                  },
                ]}
              />
            ) : null}
            {filteredDevices.slice(0, radarPositions.length).map((device, index) => (
              <View
                key={device.endpointId || device.id || index}
                style={[styles.radarDeviceMarker, radarPositions[index]]}
              >
                <View style={styles.radarDeviceDot}>
                  <Ionicons name="phone-portrait" size={13} color={COLORS.background} />
                </View>
                <Text style={styles.radarDeviceLabel} numberOfLines={1}>
                  {(device.name || device.endpointName || 'Device').split(/[ ·-]/)[0].slice(0, 10)}
                </Text>
              </View>
            ))}
            <View style={styles.radarCenter}>
              <Ionicons name="radio" size={27} color={COLORS.background} />
            </View>
          </View>

          <TouchableOpacity
            style={[styles.radarScanButton, isScanning && styles.radarScanButtonActive]}
            onPress={isScanning ? stopScanning : startScanning}
            accessibilityRole="button"
            accessibilityLabel={isScanning ? 'Stop nearby scan' : 'Start nearby scan'}
            activeOpacity={0.82}
          >
            <Ionicons
              name={isScanning ? 'stop' : 'scan-outline'}
              size={19}
              color={isScanning ? COLORS.text : COLORS.background}
            />
            <Text style={[styles.radarScanButtonText, isScanning && styles.radarScanButtonTextActive]}>
              {isScanning ? 'Stop scanning' : 'Start scanning'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.radarPrivacyNote}>
            <Ionicons name="shield-checkmark-outline" size={12} color={COLORS.muted} />
            {'  '}Only nearby ChatHub devices can appear here
          </Text>
        </View>

        {renderSearchBar('Search nearby devices...')}

        <SectionTitle
          title="Available devices"
          action={`${filteredDevices.length} found`}
        />

        {filteredDevices.length > 0 ? (
          filteredDevices.map((device, index) => {
            const deviceName = device.name || device.endpointName || 'Nearby device';

            const alreadyConnected = connectedDevices.some(
              item => item.endpointId === device.endpointId
            );

            return (
              <View
                key={device.endpointId || String(index)}
                style={styles.nearbyDeviceCard}
              >
                <Avatar
                  initials={getInitials(deviceName)}
                  color="#607844"
                />

                <View style={styles.nearbyDeviceInfo}>
                  <Text style={styles.deviceName}>{deviceName}</Text>

                  <View style={styles.nearbyDeviceSubtitleRow}>
                    <Ionicons
                      name="bluetooth-outline"
                      size={13}
                      color={COLORS.muted}
                    />

                    <Text style={styles.deviceSubtitle}>
                      Nearby device
                    </Text>
                  </View>
                </View>

                {alreadyConnected ? (
                  <View style={styles.connectedPill}>
                    <Ionicons
                      name="checkmark-circle"
                      size={15}
                      color={COLORS.green}
                    />

                    <Text style={styles.connectedPillText}>
                      Connected
                    </Text>
                  </View>
                ) : (
                  <View style={styles.nearbyDeviceActions}>
                    <TouchableOpacity
                      style={styles.connectButton}
                      onPress={() => connectToDevice(device)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.connectButtonText}>Connect</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deviceBlockButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Block ${deviceName}`}
                      onPress={() => blockDevice(device.endpointId, deviceName)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="ban-outline" size={17} color="#FF9B9B" />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })
        ) : (
          <EmptyState
            compact
            icon="radio-outline"
            title={
              searchQuery
                ? 'No matching devices'
                : isScanning
                  ? 'Looking for nearby phones'
                  : 'No devices found yet'
            }
            description={
              searchQuery
                ? 'Try a different device name.'
                : 'Open ChatHub on both phones and allow Nearby permissions.'
            }
          />
        )}
        {renderConnectionQrCard()}
      </ScrollView>
    );
  }

  function renderChats() {
    const matchingChats = chats
      .filter(chat => (chat.name || 'Nearby device').toLowerCase().includes(searchQuery.trim().toLowerCase()))
      .filter(chat => chatFilter !== 'Unread' || chat.unread > 0)
      .filter(chat => chatFilter !== 'Groups' || chat.kind === 'group')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const groupChats = matchingChats.filter(chat => chat.kind === 'group');
    const directChats = matchingChats.filter(chat => chat.kind !== 'group');
    const filters = [
      { label: 'All', count: chats.length },
      { label: 'Unread', count: chats.filter(chat => chat.unread > 0).length },
      { label: 'Groups', count: chats.filter(chat => chat.kind === 'group').length },
    ];

    const formatListTime = chat => {
      if (!chat.updatedAt) return chat.time || '';
      const date = new Date(chat.updatedAt);
      const now = new Date();
      const sameDay = date.toDateString() === now.toDateString();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const renderChatRow = chat => {
      const lastMessage = chat.messages?.[chat.messages.length - 1];
      const preview = chat.kind === 'group' && lastMessage?.senderName
        ? `${lastMessage.sender === 'me' ? 'You' : lastMessage.senderName}: ${chat.message || ''}`
        : chat.message || (chat.kind === 'group' ? `${chat.memberNames?.length || 1} members` : 'No messages yet');
      return (
        <TouchableOpacity
          key={chat.id}
          style={styles.chatRow}
          onPress={() => openChat(chat)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Open chat with ${chat.name}`}
        >
          <Avatar
            initials={chat.initials || getInitials(chat.name)}
            color={chat.color}
            size={54}
            online={chat.kind === 'group' ? getGroupRecipients(chat).length > 0 : chat.online}
          />
          <View style={styles.chatInfo}>
            <View style={styles.chatNameRow}>
              <Text style={styles.chatName} numberOfLines={1}>{chat.name}</Text>
              <Text style={[styles.chatTime, chat.unread > 0 && styles.chatTimeUnread]}>{formatListTime(chat)}</Text>
            </View>
            <View style={styles.chatPreviewRow}>
              <Text style={[styles.chatPreview, chat.unread > 0 && styles.chatPreviewUnread]} numberOfLines={1}>
                {preview}
              </Text>
              {chat.unread > 0 ? (
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>{chat.unread > 99 ? '99+' : chat.unread}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </TouchableOpacity>
      );
    };

    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <View>
            <Text style={styles.pageTitle}>Chats</Text>
            <Text style={styles.chatPageSubtitle}>Your private conversations</Text>
          </View>
          <TouchableOpacity
            style={styles.newGroupButton}
            accessibilityRole="button"
            accessibilityLabel="Create a group chat"
            onPress={() => setIsGroupModalOpen(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="people-outline" size={17} color={COLORS.background} />
            <Text style={styles.newGroupButtonText}>New group</Text>
          </TouchableOpacity>
        </View>

        {renderSearchBar('Search conversations')}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chatFiltersScroll}
          contentContainerStyle={styles.chatFilters}
        >
          {filters.map(filter => {
            const active = chatFilter === filter.label;
            return (
              <TouchableOpacity
                key={filter.label}
                style={[styles.chatFilterChip, active && styles.chatFilterChipActive]}
                onPress={() => setChatFilter(filter.label)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                activeOpacity={0.75}
              >
                <Text style={[styles.chatFilterText, active && styles.chatFilterTextActive]}>{filter.label}</Text>
                {filter.count > 0 ? (
                  <Text style={[styles.chatFilterCount, active && styles.chatFilterTextActive]}>{filter.count}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {matchingChats.length > 0 ? (
          <View style={styles.chatList}>
            {groupChats.length > 0 ? (
              <>
                <SectionTitle title="Groups" />
                {groupChats.map(renderChatRow)}
              </>
            ) : null}
            {directChats.length > 0 ? (
              <>
                <SectionTitle title={chatFilter === 'Unread' ? 'Unread conversations' : 'Direct messages'} />
                {directChats.map(renderChatRow)}
              </>
            ) : null}
          </View>
        ) : (
          <EmptyState
            icon={searchQuery || chatFilter !== 'All' ? 'search-outline' : 'chatbubbles-outline'}
            title={searchQuery ? 'No conversations found' : chatFilter === 'Unread' ? 'All caught up' : chatFilter === 'Groups' ? 'No groups yet' : 'No conversations yet'}
            description={searchQuery ? 'Try another name.' : chatFilter === 'Unread' ? 'New messages will show up here.' : chatFilter === 'Groups' ? 'Start a group with connected people.' : 'Connect to someone nearby to start chatting.'}
          />
        )}

        <Modal
          visible={isGroupModalOpen}
          transparent
          animationType="slide"
          onRequestClose={() => setIsGroupModalOpen(false)}
        >
          <View style={styles.groupModalBackdrop}>
            <View style={styles.groupModal}>
              <View style={styles.groupModalHeader}>
                <Text style={styles.groupModalTitle}>New group chat</Text>
                <IconButton name="close" onPress={() => setIsGroupModalOpen(false)} />
              </View>
              <Text style={styles.groupModalDescription}>
                Choose a group name and select the connected people to add.
              </Text>
              <TextInput
                style={styles.groupNameInput}
                value={newGroupName}
                onChangeText={setNewGroupName}
                placeholder="Group name"
                placeholderTextColor={COLORS.muted}
                maxLength={40}
                returnKeyType="done"
                autoFocus
              />
              <Text style={styles.groupMemberHeading}>Connected devices</Text>
              {connectedDevices.length > 0 ? (
                <ScrollView style={styles.groupMemberList}>
                  {connectedDevices.map(device => {
                    const selected = selectedGroupMembers.includes(device.endpointId);
                    return (
                      <TouchableOpacity
                        key={device.endpointId}
                        style={[styles.groupMemberOption, selected && styles.groupMemberOptionSelected]}
                        onPress={() => setSelectedGroupMembers(previous => selected
                          ? previous.filter(id => id !== device.endpointId)
                          : [...previous, device.endpointId]
                        )}
                        activeOpacity={0.75}
                      >
                        <Avatar initials={device.initials || getInitials(device.name)} color={device.color} size={36} online />
                        <Text style={styles.groupMemberName}>{device.name}</Text>
                        <Ionicons
                          name={selected ? 'checkbox' : 'square-outline'}
                          size={21}
                          color={selected ? COLORS.green : COLORS.muted}
                        />
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : (
                <Text style={styles.groupNoMembers}>Connect to at least one device before creating a group.</Text>
              )}
              <View style={styles.groupModalActions}>
                <TouchableOpacity
                  style={styles.groupCancelButton}
                  onPress={() => setIsGroupModalOpen(false)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.groupCancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.groupCreateButton, (!newGroupName.trim() || selectedGroupMembers.length === 0) && styles.groupCreateButtonDisabled]}
                  onPress={createGroupChat}
                  disabled={!newGroupName.trim() || selectedGroupMembers.length === 0}
                  activeOpacity={0.8}
                >
                  <Text style={styles.groupCreateButtonText}>Create group</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    );
  }
    function renderRequests() {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <Text style={styles.pageTitle}>Requests</Text>
        </View>

        {requests.length > 0 ? (
          requests.map(request => (
            <View key={request.id} style={styles.requestCard}>
              <View style={styles.requestPerson}>
                <Avatar
                  initials={
                    request.initials || getInitials(request.name)
                  }
                  color={request.color || '#7558A6'}
                  size={54}
                />

                <View style={styles.requestPersonInfo}>
                  <Text style={styles.requestPersonName}>
                    {request.name}
                  </Text>

                  <Text style={styles.requestPersonDescription}>
                    {request.detail || 'Wants to connect with you'}
                  </Text>

                  <View style={styles.requestPrivateBadge}>
                    <Ionicons
                      name="shield-checkmark-outline"
                      size={12}
                      color={COLORS.green}
                    />

                    <Text style={styles.requestPrivateText}>
                      Nearby connection
                    </Text>
                  </View>
                </View>
              </View>

              {request.authenticationToken ? (
                <View style={styles.requestAuthCodeContainer}>
                  <Text style={styles.requestAuthCodeLabel}>COMPARE CODE ON BOTH DEVICES</Text>
                  <Text style={styles.requestAuthCode}>{request.authenticationToken}</Text>
                </View>
              ) : (
                <Text style={styles.requestAuthCodeMissing}>Verification code unavailable. Do not accept.</Text>
              )}

              <View style={styles.requestActions}>
                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => acceptRequest(request)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="checkmark"
                    size={18}
                    color="#1A1424"
                  />

                  <Text style={styles.acceptButtonText}>Accept</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.rejectButton}
                  onPress={() => rejectRequest(request)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="close"
                    size={18}
                    color={COLORS.text}
                  />

                  <Text style={styles.rejectButtonText}>Decline</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.blockButton}
                  onPress={() => blockDevice(request.endpointId, request.name, true)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="ban-outline" size={16} color="#FF9B9B" />
                  <Text style={styles.blockButtonText}>Block</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))
        ) : (
          <EmptyState
            icon="person-add-outline"
            title="All caught up"
            description="When someone requests a connection, it will appear here."
          />
        )}

        <View style={styles.infoCard}>
          <Ionicons
            name="lock-closed-outline"
            size={21}
            color={COLORS.primary}
          />

          <Text style={styles.infoCardText}>
            Accept requests only from people you recognize or trust.
          </Text>
        </View>
      </ScrollView>
    );
  }

  function renderProfile() {
    const publicUserId = getFullProfileId();
    const meshFingerprint = profileKey(profileId).toUpperCase();
    const shortenIdentifier = value => value.length > 28
      ? `${value.slice(0, 14)}…${value.slice(-10)}`
      : value;

    const copyProfileValue = async (value, label) => {
      try {
        await Clipboard.setStringAsync(value);
        setNotice(`${label} copied`);
      } catch (error) {
        console.warn(`Could not copy ${label}:`, error);
        setNotice(`Could not copy ${label}`);
      }
    };

    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <Text style={styles.pageTitle}>Profile</Text>
        </View>

        <View style={styles.profileCard}>
          <View style={styles.profileAvatarWrapper}>
            <View style={styles.profileAvatar}>
              <Text style={styles.profileAvatarText}>
                {getInitials(profileName || 'U')}
              </Text>
            </View>

            <View style={styles.profileVerifiedBadge}>
              <Ionicons
                name="checkmark"
                size={14}
                color="#1A1424"
              />
            </View>
          </View>

          {isEditingProfile ? (
            <TextInput
              style={styles.profileNameInput}
              value={profileName}
              onChangeText={name => {
                profileNameDirtyRef.current = true;
                setProfileName(name);
              }}
              placeholder="Enter your name"
              placeholderTextColor={COLORS.muted}
              maxLength={30}
              autoFocus
            />
          ) : (
            <Text style={styles.profileName}>
              {profileName || 'ChatHub User'}
            </Text>
          )}

          <View style={styles.profileIdBlock}>
            <View style={styles.profileIdentifierHeader}>
              <Text style={styles.profileIdLabel}>PUBLIC USER ID</Text>
              <TouchableOpacity
                style={styles.copyIdentifierButton}
                onPress={() => copyProfileValue(publicUserId, 'Public ID')}
                accessibilityRole="button"
                accessibilityLabel="Copy public user ID"
              >
                <Ionicons name="copy-outline" size={14} color={COLORS.primary} />
                <Text style={styles.copyIdentifierText}>Copy</Text>
              </TouchableOpacity>
            </View>
            <Text selectable style={styles.profileIdValue}>{shortenIdentifier(publicUserId)}</Text>
            <Text style={styles.profileIdHint}>Your permanent ID on this phone.</Text>
            <View style={styles.profileIdDivider} />
            <View style={styles.profileIdentifierHeader}>
              <Text style={styles.profileIdLabel}>MESH FINGERPRINT</Text>
              <TouchableOpacity
                style={styles.copyIdentifierButton}
                onPress={() => copyProfileValue(meshFingerprint, 'Fingerprint')}
                accessibilityRole="button"
                accessibilityLabel="Copy mesh fingerprint"
              >
                <Ionicons name="copy-outline" size={14} color={COLORS.primary} />
                <Text style={styles.copyIdentifierText}>Copy</Text>
              </TouchableOpacity>
            </View>
            <Text selectable style={styles.meshFingerprint}>{shortenIdentifier(meshFingerprint)}</Text>
            <Text style={styles.profileIdHint}>Match it with a contact to verify identity.</Text>
            <Text style={styles.profileIdHint}>Tap and hold an ID to select its full value.</Text>
          </View>



          <TouchableOpacity
            style={styles.editProfileButton}
            onPress={() => {
              if (isEditingProfile) {
                setIsEditingProfile(false);
                persistProfileName(profileName)
                  .then(savedName => setNotice(`Profile name saved as ${savedName}`))
                  .catch(error => {
                    console.warn('Could not save profile name:', error);
                    setNotice('Could not save profile name');
                  });
              } else {
                setIsEditingProfile(true);
              }
            }}
            activeOpacity={0.8}
          >
            <Ionicons
              name={isEditingProfile ? 'checkmark-outline' : 'create-outline'}
              size={17}
              color={COLORS.text}
            />

            <Text style={styles.editProfileButtonText}>
              {isEditingProfile ? 'Save changes' : 'Edit profile'}
            </Text>
          </TouchableOpacity>
        </View>

        <SectionTitle title="Connection overview" />

        <View style={styles.profileStats}>
          <View style={styles.profileStatCard}>
            <Ionicons
              name="radio-outline"
              size={22}
              color={COLORS.primary}
            />

            <Text style={styles.profileStatValue}>
              {nearbyDevices.length}
            </Text>

            <Text style={styles.profileStatLabel}>
              Nearby
            </Text>
          </View>

          <View style={styles.profileStatCard}>
            <Ionicons
              name="link-outline"
              size={22}
              color={COLORS.green}
            />

            <Text style={styles.profileStatValue}>
              {connectedDevices.length}
            </Text>

            <Text style={styles.profileStatLabel}>
              Connected
            </Text>
          </View>

          <View style={styles.profileStatCard}>
            <Ionicons
              name="chatbubbles-outline"
              size={22}
              color={COLORS.purple}
            />

            <Text style={styles.profileStatValue}>
              {chats.length}
            </Text>

            <Text style={styles.profileStatLabel}>
              Chats
            </Text>
          </View>
        </View>

        <SectionTitle title={`Blocked devices (${blockedDevices.length})`} />
        {blockedDevices.length > 0 ? (
          <View style={styles.blockedDevicesList}>
            {blockedDevices.map(device => (
              <View key={normalizeDeviceName(device.name)} style={styles.blockedDeviceRow}>
                <View style={styles.settingIcon}>
                  <Ionicons name="ban-outline" size={19} color="#FF9B9B" />
                </View>
                <View style={styles.settingContent}>
                  <Text style={styles.settingTitle}>{device.name}</Text>
                  <Text style={styles.settingDescription}>Blocked by displayed name</Text>
                </View>
                <TouchableOpacity
                  style={styles.unblockButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Unblock ${device.name}`}
                  onPress={() => unblockDevice(device.name)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.unblockButtonText}>Unblock</Text>
                </TouchableOpacity>
              </View>
            ))}
            <Text style={styles.blockedDevicesNote}>
              Devices with the same displayed name are blocked together. A device can change its name.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    );
  }

  function renderChatScreen() {
    if (!selectedChat) return null;
    const isGroupChat = selectedChat.kind === 'group';
    const liveChat = chats.find(chat => isGroupChat
      ? chat.kind === 'group' && chat.id === selectedChat.id
      : (selectedChat.profileId && chat.profileId === selectedChat.profileId)
        || (selectedChat.endpointId && chat.endpointId === selectedChat.endpointId)
    ) || selectedChat;
    const groupRecipients = isGroupChat ? getGroupRecipients(liveChat) : [];
    const directConnected = !isGroupChat && connectedDevices.some(device => device.endpointId === liveChat.endpointId);
    const meshRouteAvailable = connectedDevices.length > 0 && (isGroupChat
      ? getGroupMemberIds(liveChat).some(id => meshPeersRef.current.has(profileKey(id)) && profileKey(id) !== profileKey(profileId))
      : Boolean(liveChat.profileId && meshPeersRef.current.has(liveChat.profileId)));
    const connected = isGroupChat
      ? meshRouteAvailable
      : directConnected || meshRouteAvailable;
    const groupMemberCount = Math.max(0, (liveChat.memberNames || []).length - 1);
    const messages = liveChat.messages || [];

    return (
      <View style={styles.chatScreen}>
        <View style={styles.chatScreenHeader}>
          <IconButton name="arrow-back" size={23} onPress={closeChat} />
          <Avatar
            initials={liveChat.initials || getInitials(liveChat.name)}
            color={liveChat.color || '#607844'}
            size={42}
            online={connected}
          />
          <View style={styles.chatScreenHeaderInfo}>
            <Text style={styles.chatScreenName}>{liveChat.name || 'Nearby device'}</Text>
            <Text style={styles.chatScreenStatus}>
              {isGroupChat
                ? `Group · ${groupRecipients.length}/${groupMemberCount} nearby`
                : directConnected ? 'Connected nearby' : meshRouteAvailable ? 'Connected through mesh' : 'Not connected'}
            </Text>
          </View>
          <IconButton
            name="ellipsis-vertical"
            size={21}
            onPress={() => setNotice(connected ? 'Disconnect from the Nearby tab to end this chat.' : 'Open Nearby and connect to this device first.')}
          />
        </View>

        <View style={styles.chatScreenBody}>
          <View style={styles.chatEncryptionBadge}>
            <Ionicons name="shield-checkmark-outline" size={17} color={COLORS.green} />
            <Text style={styles.chatEncryptionText}>Text encrypted end-to-end</Text>
          </View>

          <ScrollView
            style={styles.messagesList}
            contentContainerStyle={styles.messagesContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {messages.length === 0 ? (
              <EmptyState
                icon="chatbubble-ellipses-outline"
                title="Start a conversation"
                description={connected
                  ? isGroupChat ? 'Send a message to the group below.' : 'You are connected. Send your first message below.'
                  : 'Connect to this device in Nearby before sending a message.'}
              />
            ) : messages.map(message => (
              <View
                key={message.id}
                style={[
                  styles.messageRow,
                  message.sender === 'me' ? styles.messageRowMine : styles.messageRowTheirs,
                ]}
              >
                <View style={[
                  styles.messageBubbleColumn,
                  message.sender === 'me' ? styles.messageBubbleColumnMine : styles.messageBubbleColumnTheirs,
                ]}>
                <View style={[
                  styles.messageBubble,
                  message.sender === 'me' ? styles.messageBubbleMine : styles.messageBubbleTheirs,
                ]}>
                  {message.type === 'image' && message.uri ? (
                    <Image source={{ uri: message.uri }} style={styles.messageImage} resizeMode="cover" />
                  ) : message.type === 'audio' ? (
                    <VoiceMessage uri={message.uri} />
                  ) : message.type === 'file' ? (
                    <View style={styles.sharedFilePreview}>
                      <Ionicons name="document-text-outline" size={22} color={COLORS.primary} />
                      <View style={styles.sharedFileInfo}>
                        <Text style={styles.sharedFileName} numberOfLines={2}>{message.name || 'Shared file'}</Text>
                        <Text style={styles.sharedFileType} numberOfLines={1}>{message.mimeType || 'File'}</Text>
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.messageText}>{message.text}</Text>
                  )}
                  <View style={styles.messageMeta}>
                    <Text style={styles.messageTime}>
                      {new Date(message.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    {message.sender === 'me' ? (
                      <Text style={[styles.messageStatus, message.status === 'partial' && styles.messageStatusPartial]}>
                        {message.status === 'failed' ? 'Failed' : message.status === 'partial' ? 'Partial' : message.status === 'sending' ? 'Sending…' : message.status === 'sent' && !message.type ? 'Forwarded' : 'Sent'}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <View style={styles.messageActions}>
                  {message.type && message.uri ? (
                    <TouchableOpacity
                      style={styles.messageActionButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Share ${message.name || 'attachment'}`}
                      onPress={() => shareChatFile(message)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="share-outline" size={15} color={COLORS.primary} />
                    </TouchableOpacity>
                  ) : null}
                    {message.sender === 'me' && ['failed', 'partial'].includes(message.status) ? (
                    <TouchableOpacity
                      style={styles.messageActionButton}
                      accessibilityRole="button"
                      accessibilityLabel="Retry sending message"
                      onPress={() => isGroupChat
                        ? retryGroupMessage(liveChat, message)
                        : retryChatMessage(liveChat.profileId || liveChat.endpointId, message)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="refresh" size={15} color={COLORS.primary} />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.messageActionButton}
                    accessibilityRole="button"
                    accessibilityLabel="Delete message from this phone"
                      onPress={() => deleteChatMessage(liveChat, message.id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="trash-outline" size={15} color={COLORS.muted} />
                  </TouchableOpacity>
                </View>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>

        <View style={styles.chatComposer}>
          <TouchableOpacity
            style={styles.chatToolButton}
            accessibilityRole="button"
            accessibilityLabel="Attach a file"
            onPress={pickChatFile}
            disabled={!directConnected || isRecordingVoice || isGroupChat}
            activeOpacity={0.75}
          >
            <Ionicons name="attach-outline" size={20} color={directConnected && !isGroupChat ? COLORS.muted : COLORS.border} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.chatToolButton, isRecordingVoice && styles.chatToolButtonRecording]}
            accessibilityRole="button"
            accessibilityLabel={isRecordingVoice ? 'Stop recording voice message' : 'Record voice message'}
            onPress={toggleVoiceRecording}
            disabled={(!directConnected || isGroupChat) && !isRecordingVoice}
            activeOpacity={0.75}
          >
            <Ionicons
              name={isRecordingVoice ? 'stop' : 'mic-outline'}
              size={18}
              color={isRecordingVoice ? '#FF9B9B' : directConnected && !isGroupChat ? COLORS.muted : COLORS.border}
            />
          </TouchableOpacity>
          <View style={styles.chatComposerInput}>
            <TextInput
              style={styles.chatComposerText}
              placeholder={isRecordingVoice ? 'Recording voice message…' : isGroupChat ? 'Write a group message…' : connected ? 'Write a message…' : 'Connect to send messages'}
              placeholderTextColor={COLORS.muted}
              value={messageDraft}
              onChangeText={setMessageDraft}
              editable={connected && !isRecordingVoice}
              multiline
              maxLength={4000}
              returnKeyType="send"
              onSubmitEditing={sendChatMessage}
            />
          </View>
          <TouchableOpacity
            style={[styles.chatSendButton, (!connected || !messageDraft.trim()) && styles.chatSendButtonDisabled]}
            onPress={sendChatMessage}
            disabled={!connected || !messageDraft.trim()}
            activeOpacity={0.8}
          >
            <Ionicons name="send" size={19} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

    function renderBottomNavigation() {
    const tabs = [
      {
        name: 'Home',
        icon: 'home-outline',
        activeIcon: 'home',
        color: COLORS.primary,
      },
      {
        name: 'Nearby',
        icon: 'radio-outline',
        activeIcon: 'radio',
        color: COLORS.cyan,
      },
      {
        name: 'Chats',
        icon: 'chatbubbles-outline',
        activeIcon: 'chatbubbles',
        color: COLORS.blue,
      },
      {
        name: 'Requests',
        icon: 'people-outline',
        activeIcon: 'people',
        color: COLORS.pink,
      },
      {
        name: 'Profile',
        icon: 'person-outline',
        activeIcon: 'person',
        color: COLORS.violet,
      },
    ];

    return (
      <View style={styles.bottomNavigation}>
        {tabs.map(tab => {
          const active = activeTab === tab.name;

          return (
            <TouchableOpacity
              key={tab.name}
              style={styles.navItem}
              accessibilityRole="button"
              accessibilityLabel={`${tab.name} tab`}
              accessibilityState={{ selected: active }}
              onPress={() => {
                setSelectedChat(null);
                setActiveTab(tab.name);
                setSearchQuery('');
              }}
              activeOpacity={0.75}
            >
              <View
                style={[
                  styles.navIconWrapper,
                  active && { backgroundColor: `${tab.color}22` },
                ]}
              >
                <Ionicons
                  name={active ? tab.activeIcon : tab.icon}
                  size={21}
                  color={active ? tab.color : COLORS.muted}
                />

                {tab.name === 'Requests' && requests.length > 0 && (
                  <View style={styles.navBadge} />
                )}
              </View>

              <Text
                style={[
                  styles.navLabel,
                  active && { color: tab.color, fontWeight: '800' },
                ]}
              >
                {tab.name}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  function renderNotice() {
    if (!notice) {
      return null;
    }

    return (
      <View style={styles.noticeContainer}>
        <Ionicons
          name="information-circle-outline"
          size={20}
          color={COLORS.primary}
        />

        <Text style={styles.noticeText}>{notice}</Text>

        <TouchableOpacity
          onPress={() => setNotice('')}
          activeOpacity={0.7}
        >
          <Ionicons
            name="close"
            size={19}
            color={COLORS.muted}
          />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={COLORS.background}
      />

      <View style={styles.pageBlurTarget}>
        {renderHeader()}
        <View style={styles.mainContent}>
          {selectedChat
            ? renderChatScreen()
            : activeTab === 'Home'
              ? renderHome()
              : activeTab === 'Nearby'
                ? renderNearby()
                : activeTab === 'Chats'
                  ? renderChats()
                  : activeTab === 'Requests'
                    ? renderRequests()
                    : renderProfile()}
        </View>
      </View>

      {!selectedChat && renderBottomNavigation()}

      {renderNotice()}

      <Modal
        visible={isQrScannerOpen}
        animationType="slide"
        onRequestClose={() => setIsQrScannerOpen(false)}
      >
        <View style={styles.qrScannerScreen}>
          <View style={styles.qrModalHeader}>
            <View>
              <Text style={styles.qrModalEyebrow}>SECURE CONNECTION</Text>
              <Text style={styles.qrModalTitle}>Scan connection QR</Text>
            </View>
            <IconButton name="close" onPress={() => setIsQrScannerOpen(false)} />
          </View>
          <Text style={styles.qrModalDescription}>
            Verify identity once. Tap Connect nearby later; saved devices skip code confirmation.
          </Text>
          <View style={styles.cameraFrame}>
            <CameraView
              style={styles.cameraPreview}
              active={isQrScannerOpen}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleConnectionQrScanned}
              onCameraReady={() => {
                setCameraMountError('');
                setIsCameraReady(true);
              }}
              onMountError={event => {
                setCameraMountError(event.message || 'Camera preview could not start.');
                setIsCameraReady(false);
              }}
            />
            {!isCameraReady && !cameraMountError ? (
              <View pointerEvents="none" style={styles.cameraMessageOverlay}>
                <Text style={styles.cameraMessageText}>Starting camera…</Text>
              </View>
            ) : null}
            {cameraMountError ? (
              <View style={styles.cameraErrorOverlay}>
                <Ionicons name="camera-outline" size={25} color={COLORS.text} />
                <Text style={styles.cameraMessageText}>{cameraMountError}</Text>
                <TouchableOpacity
                  style={styles.cameraRetryButton}
                  onPress={() => {
                    setCameraMountError('');
                    setIsCameraReady(false);
                    setIsQrScannerOpen(false);
                    setTimeout(() => setIsQrScannerOpen(true), 150);
                  }}
                >
                  <Text style={styles.cameraRetryText}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <View pointerEvents="none" style={styles.cameraScanOutline} />
          </View>
          <Text style={styles.cameraHint}>Keep the QR inside the frame</Text>
        </View>
      </Modal>

      <Modal
        visible={isMyQrOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMyQrOpen(false)}
      >
        <View style={styles.profileSetupBackdrop}>
          <ScrollView
            style={styles.qrModalScroll}
            contentContainerStyle={styles.qrModalScrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.myQrModal}>
              <View style={styles.qrModalHeader}>
                <View style={styles.qrModalHeadingCopy}>
                  <Text style={styles.qrModalEyebrow}>SHARE TO CONNECT</Text>
                  <Text style={styles.qrModalTitle}>Your connection QR</Text>
                </View>
                <IconButton name="close" onPress={() => setIsMyQrOpen(false)} />
              </View>
              <Text style={styles.qrModalDescription}>
                Let someone scan this code, then both phones can find each other using nearby discovery.
              </Text>
              {getConnectionQrValue() ? (
                <View style={[styles.qrCodePaper, { width: qrCodeSize + 32, height: qrCodeSize + 32 }]}>
                  <QRCode value={getConnectionQrValue()} size={qrCodeSize} color="#081018" backgroundColor="#FFFFFF" />
                </View>
              ) : (
                <Text style={styles.qrModalDescription}>Your secure profile is still being prepared.</Text>
              )}
              <Text style={styles.qrOwnerName}>{getPublicDisplayName()}</Text>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={isProfileSetupVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.profileSetupBackdrop}>
          <View style={styles.profileSetupModal}>
            <View style={styles.profileSetupIcon}>
              <Ionicons name="person-add-outline" size={24} color={COLORS.text} />
            </View>
            <Text style={styles.profileSetupTitle}>Welcome to ChatHub</Text>
            <Text style={styles.profileSetupDescription}>
              Add your first name so nearby people can recognize you. You can change it later in Profile.
            </Text>
            <TextInput
              style={styles.profileSetupInput}
              value={profileSetupName}
              onChangeText={setProfileSetupName}
              placeholder="First name"
              placeholderTextColor={COLORS.muted}
              maxLength={30}
              autoCapitalize="words"
              autoFocus
            />
            <View style={styles.profileSetupActions}>
              <TouchableOpacity
                style={styles.profileSetupGeneratedButton}
                onPress={() => finishProfileSetup(getGeneratedDisplayName(profileId))}
                activeOpacity={0.8}
              >
                <Text style={styles.profileSetupGeneratedText}>{getGeneratedDisplayName(profileId)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.profileSetupSaveButton, !profileSetupName.trim() && styles.profileSetupSaveButtonDisabled]}
                onPress={() => finishProfileSetup(profileSetupName)}
                disabled={!profileSetupName.trim()}
                activeOpacity={0.8}
              >
                <Text style={styles.profileSetupSaveText}>Continue</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.profileSetupId}>ID: {getFullProfileId()}</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );}
  const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  pageBlurTarget: {
    flex: 1,
  },

  header: {
    minHeight: 72,
    paddingHorizontal: 20,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.background,
  },

  brandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },

  brandIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },

  brandTitle: {
    color: COLORS.text,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  brandSubtitle: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.35,
    marginTop: 3,
  },

  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  privacyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(184,243,107,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.2)',
    borderRadius: 20,
  },

  privacyBadgeText: {
    color: COLORS.green,
    fontSize: 11,
    fontWeight: '700',
  },

  iconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },

  mainContent: {
    flex: 1,
  },

  screenContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 30,
  },

  greetingContainer: {
    marginBottom: 20,
  },

  greetingTitle: {
    color: COLORS.text,
    fontSize: 31,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  greetingEyebrow: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 3,
  },

  greetingSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },

  scannerCard: {
    backgroundColor: '#101D27',
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.24)',
    borderRadius: 24,
    padding: 18,
    marginBottom: 18,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22,
    shadowRadius: 20,
    elevation: 7,
  },

  scannerCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },

  scannerTextContainer: {
    flex: 1,
  },

  scannerTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  scannerDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 7,
  },

  scannerVisual: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 98,
    height: 98,
  },

  scannerPulseRing: {
    position: 'absolute',
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1.5,
    borderColor: COLORS.green,
  },

  scannerCircleOuter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 1,
    borderColor: '#355044',
    backgroundColor: '#102129',
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerCircleMiddle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(131,223,200,0.55)',
    backgroundColor: 'rgba(131,223,200,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerCircleInner: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerDivider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginTop: 16,
    marginBottom: 14,
  },

  scannerBottom: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 12,
    flexWrap: 'wrap',
  },

  scannerActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },

  scannerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
  },

  scannerStatusText: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '600',
  },

  scanButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    paddingHorizontal: 17,
    paddingVertical: 12,
  },

  qrActionButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 11,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.25)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },

  qrActionText: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '700',
  },

  qrConnectCard: {
    marginTop: -10,
    marginBottom: 26,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },

  qrConnectHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },

  qrConnectIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: 'rgba(184,243,107,0.1)',
  },

  qrConnectCopy: {
    flex: 1,
  },

  qrConnectTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },

  qrConnectDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },

  qrConnectActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 15,
  },

  scanButtonActive: {
    backgroundColor: '#1A282D',
    borderWidth: 1,
    borderColor: COLORS.green,
  },

  scanButtonText: {
    color: COLORS.background,
    fontSize: 12,
    fontWeight: '800',
  },

  scanButtonTextActive: {
    color: COLORS.text,
  },

  statsContainer: {
    flexDirection: 'row',
    gap: 11,
    marginBottom: 22,
  },

  homeQuickActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },

  homeQuickAction: {
    flex: 1,
    minWidth: 0,
    minHeight: 67,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  homeQuickIcon: {
    width: 36,
    height: 36,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },

  homeQuickCopy: {
    flex: 1,
    minWidth: 0,
  },

  homeQuickTitle: {
    color: COLORS.text,
    fontSize: 11,
    fontWeight: '800',
  },

  homeQuickSubtitle: {
    color: COLORS.muted,
    fontSize: 9,
    marginTop: 4,
  },

  statCard: {
    flex: 1,
    minWidth: 0,
    padding: 14,
    borderRadius: 18,
    backgroundColor: '#111D26',
    borderWidth: 1,
    borderColor: '#293A46',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 3,
  },

  statIcon: {
    width: 35,
    height: 35,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },

  statValue: {
    color: COLORS.text,
    fontSize: 23,
    fontWeight: '800',
  },

  statLabel: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },

  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 9,
    marginBottom: 15,
  },

  sectionTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },

  sectionAction: {
    color: COLORS.primary,
    fontSize: 13,
    paddingVertical: 8,
    paddingHorizontal: 6,
    fontWeight: '700',
  },

  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 18,
    marginBottom: 12,
  },

  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    flexShrink: 0,
  },

  avatarText: {
    color: COLORS.text,
    fontWeight: '800',
  },

  onlineDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    backgroundColor: COLORS.green,
    borderWidth: 2,
    borderColor: COLORS.surface,
  },

  deviceInfo: {
    flex: 1,
    marginLeft: 12,
  },

  deviceName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '700',
  },

  deviceSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 5,
    lineHeight: 16,
  },

  compactEmptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 17,
    marginBottom: 27,
  },

  compactEmptyIcon: {
    width: 43,
    height: 43,
    borderRadius: 13,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },

  compactEmptyText: {
    flex: 1,
    marginLeft: 12,
  },

  compactEmptyTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },

  compactEmptyDescription: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 5,
    lineHeight: 15,
  },

  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 78,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },

  chatInfo: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
  },

  chatNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },

  chatName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '750',
    flexShrink: 1,
  },

  chatTime: {
    color: COLORS.muted,
    fontSize: 10,
    marginLeft: 6,
  },

  chatTimeUnread: {
    color: COLORS.primary,
    fontWeight: '700',
  },

  chatPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 5,
  },

  chatPreview: {
    color: COLORS.muted,
    fontSize: 12,
    flex: 1,
  },

  chatPreviewUnread: {
    color: COLORS.text,
    fontWeight: '600',
  },

  unreadBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 9,
  },

  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },

  pageHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },

  pageTitle: {
    color: COLORS.text,
    fontSize: 29,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  chatPageSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },

  chatFiltersScroll: {
    flexGrow: 0,
    marginTop: -7,
    marginBottom: 12,
  },

  chatFilters: {
    flexDirection: 'row',
    gap: 9,
    paddingBottom: 2,
  },

  chatFilterChip: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  chatFilterChipActive: {
    backgroundColor: 'rgba(184,243,107,0.14)',
    borderColor: 'rgba(184,243,107,0.5)',
  },

  chatFilterText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },

  chatFilterTextActive: {
    color: COLORS.primary,
  },

  chatFilterCount: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '700',
  },

  chatList: {
    marginTop: 2,
  },

  searchBar: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 17,
    marginBottom: 21,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 2,
  },

  searchInput: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 14,
    paddingVertical: 12,
  },

  discoveryStatusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: 16,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 14,
  },

  discoveryStatusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },

  discoveryStatusIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: 'rgba(98,216,232,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  discoveryStatusIconActive: {
    backgroundColor: 'rgba(98,216,232,0.2)',
  },

  discoveryStatusText: {
    flex: 1,
    marginLeft: 12,
  },

  discoveryStatusTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },

  discoveryStatusSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 5,
  },

  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#201E27',
  },

  statusPillActive: {
    backgroundColor: '#1A282D',
  },

  statusPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.muted,
  },

  statusPillDotActive: {
    backgroundColor: COLORS.green,
  },

  statusPillText: {
    color: COLORS.muted,
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  statusPillTextActive: {
    color: COLORS.green,
  },

  nearbyPageSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },

  radarCard: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 18,
    paddingBottom: 15,
    marginBottom: 18,
    borderRadius: 25,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },

  radarHeading: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 10,
  },

  radarTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },

  radarSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 4,
  },

  radarSignalIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: 'rgba(184,243,107,0.1)',
  },

  radarCanvas: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginVertical: 3,
    borderRadius: 999,
    backgroundColor: '#0B1720',
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.18)',
    overflow: 'hidden',
  },

  radarRing: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.16)',
  },

  radarRingOuter: {
    width: '88%',
    height: '88%',
  },

  radarRingMiddle: {
    width: '62%',
    height: '62%',
  },

  radarRingInner: {
    width: '34%',
    height: '34%',
  },

  radarCrosshairVertical: {
    position: 'absolute',
    width: 1,
    height: '100%',
    backgroundColor: 'rgba(184,243,107,0.08)',
  },

  radarCrosshairHorizontal: {
    position: 'absolute',
    width: '100%',
    height: 1,
    backgroundColor: 'rgba(184,243,107,0.08)',
  },

  radarPulseRing: {
    position: 'absolute',
    width: '72%',
    height: '72%',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: COLORS.primary,
    backgroundColor: 'rgba(184,243,107,0.035)',
  },

  radarCenter: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 29,
    backgroundColor: COLORS.primary,
    borderWidth: 5,
    borderColor: 'rgba(184,243,107,0.2)',
    zIndex: 2,
  },

  radarDeviceMarker: {
    position: 'absolute',
    zIndex: 3,
    alignItems: 'center',
    width: 66,
  },

  radarDeviceDot: {
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: COLORS.cyan,
    borderWidth: 2,
    borderColor: '#D8FFFF',
    shadowColor: COLORS.cyan,
    shadowOpacity: 0.45,
    shadowRadius: 8,
    elevation: 4,
  },

  radarDeviceLabel: {
    maxWidth: 66,
    color: COLORS.text,
    fontSize: 9,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 3,
    paddingHorizontal: 4,
    borderRadius: 5,
    backgroundColor: 'rgba(7,17,27,0.82)',
  },

  radarScanButton: {
    width: '100%',
    minHeight: 49,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    borderRadius: 15,
    backgroundColor: COLORS.primary,
  },

  radarScanButtonActive: {
    backgroundColor: '#1B2B2D',
    borderWidth: 1,
    borderColor: COLORS.primary,
  },

  radarScanButtonText: {
    color: COLORS.background,
    fontSize: 13,
    fontWeight: '800',
  },

  radarScanButtonTextActive: {
    color: COLORS.text,
  },

  radarPrivacyNote: {
    color: COLORS.muted,
    fontSize: 9,
    textAlign: 'center',
    marginTop: 10,
  },

  primaryButton: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: COLORS.primary,
    borderRadius: 17,
    marginBottom: 27,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 4,
  },

  primaryButtonText: {
    color: '#1A1424',
    fontSize: 14,
    fontWeight: '800',
  },

  nearbyDeviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 18,
    marginBottom: 12,
  },

  nearbyDeviceInfo: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
  },

  nearbyDeviceSubtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
  },

  connectButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    marginLeft: 8,
  },

  connectButtonText: {
    color: '#1A1424',
    fontSize: 12,
    fontWeight: '800',
  },

  nearbyDeviceActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  deviceBlockButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },

  connectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#1A282D',
  },

  connectedPillText: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: '700',
  },

  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 25,
    paddingTop: 38,
    paddingBottom: 38,
  },

  emptyStateCompact: {
    paddingTop: 14,
    paddingBottom: 14,
  },

  emptyIconCompact: {
    width: 52,
    height: 52,
    borderRadius: 17,
    marginBottom: 10,
  },

  emptyStateCompactDescription: {
    fontSize: 12,
    lineHeight: 18,
  },

  emptyIcon: {
    width: 70,
    height: 70,
    borderRadius: 23,
    backgroundColor: '#1B1921',
    borderWidth: 1,
    borderColor: '#36313F',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },

  emptyTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
  },

  emptyDescription: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 9,
  },

  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 20,
  },

  infoCardText: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 19,
  },

  chatSummaryCard: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 18,
  },

  newGroupButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.38)',
  },

  newGroupButtonText: {
    color: COLORS.background,
    fontSize: 12,
    fontWeight: '800',
  },

  groupModalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(7, 4, 14, 0.82)',
  },

  groupModal: {
    maxHeight: '88%',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: Platform.OS === 'android' ? 28 : 34,
    backgroundColor: '#14131A',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  groupModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },

  groupModalTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
  },

  groupModalDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
    marginBottom: 8,
  },

  groupNameInput: {
    minHeight: 46,
    color: COLORS.text,
    fontSize: 13,
    paddingHorizontal: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    marginTop: 8,
  },

  groupMemberHeading: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 18,
    marginBottom: 8,
  },

  groupMemberList: {
    maxHeight: 220,
  },

  groupMemberOption: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },

  groupMemberOptionSelected: {
    backgroundColor: '#1A282D',
  },

  groupMemberName: {
    flex: 1,
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  groupNoMembers: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    paddingVertical: 14,
  },

  groupModalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },

  groupCancelButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
  },

  groupCancelButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  groupCreateButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.38)',
  },

  groupCreateButtonDisabled: {
    opacity: 0.45,
  },

  groupCreateButtonText: {
    color: COLORS.background,
    fontSize: 12,
    fontWeight: '800',
  },

  requestCard: {
    padding: 15,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 23,
    marginBottom: 13,
  },

  requestPerson: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  requestPersonInfo: {
    flex: 1,
    marginLeft: 12,
  },

  requestPersonName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },

  requestPersonDescription: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 5,
  },

  requestPrivateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },

  requestPrivateText: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: '600',
  },

  requestAuthCodeContainer: {
    marginTop: 14,
    padding: 12,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    alignItems: 'center',
  },

  requestAuthCodeLabel: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    textAlign: 'center',
  },

  requestAuthCode: {
    color: COLORS.green,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 2,
    textAlign: 'center',
    marginTop: 6,
  },

  requestAuthCodeMissing: {
    color: '#FF9B9B',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 14,
  },

  requestActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 17,
    flexWrap: 'wrap',
  },

  acceptButton: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.green,
    borderRadius: 12,
  },

  acceptButtonText: {
    color: '#1A1424',
    fontSize: 12,
    fontWeight: '800',
  },

  rejectButton: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#201E27',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
  },

  rejectButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  blockButton: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#2D1F2B',
    borderWidth: 1,
    borderColor: '#58374A',
    borderRadius: 12,
  },

  blockButtonText: {
    color: '#FFB0BC',
    fontSize: 12,
    fontWeight: '700',
  },

  profileCard: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 28,
    marginBottom: 25,
  },

  profileAvatarWrapper: {
    position: 'relative',
    marginBottom: 15,
  },

  profileAvatar: {
    width: 91,
    height: 91,
    borderRadius: 30,
    backgroundColor: '#607844',
    borderWidth: 3,
    borderColor: '#7D9360',
    alignItems: 'center',
    justifyContent: 'center',
  },

  profileAvatarText: {
    color: COLORS.text,
    fontSize: 31,
    fontWeight: '800',
  },

  profileVerifiedBadge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 27,
    height: 27,
    borderRadius: 14,
    backgroundColor: COLORS.green,
    borderWidth: 3,
    borderColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  profileName: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '800',
  },

  profileNameInput: {
    minWidth: 150,
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '700',
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 10,
  },

  profileIdBlock: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 14,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
  },

  profileIdLabel: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
  },

  profileIdentifierHeader: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  copyIdentifierButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
  },

  copyIdentifierText: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '700',
  },

  profileIdValue: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 6,
  },

  profileIdHint: {
    color: COLORS.muted,
    fontSize: 9,
    textAlign: 'center',
    marginTop: 5,
  },

  profileIdDivider: {
    width: '100%',
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 12,
  },

  meshFingerprint: {
    color: COLORS.primary,
    fontSize: 9,
    fontWeight: '800',
    textAlign: 'center',
    letterSpacing: 0.4,
    marginTop: 6,
  },

  profileSetupBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.66)',
  },

  qrModalScroll: {
    width: '100%',
    flexGrow: 0,
    maxHeight: '92%',
  },

  qrModalScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 6,
  },

  qrModalHeadingCopy: {
    flex: 1,
    minWidth: 0,
  },

  qrScannerScreen: {
    flex: 1,
    paddingTop: Platform.OS === 'android' ? 48 : 60,
    paddingHorizontal: 22,
    paddingBottom: 36,
    backgroundColor: COLORS.background,
  },

  qrModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },

  qrModalEyebrow: {
    color: COLORS.green,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
  },

  qrModalTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: '800',
    marginTop: 5,
  },

  qrModalDescription: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 14,
    textAlign: 'center',
  },

  cameraFrame: {
    width: '100%',
    aspectRatio: 1,
    maxHeight: 380,
    alignSelf: 'center',
    overflow: 'hidden',
    marginTop: 34,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(184,243,107,0.38)',
    backgroundColor: '#111A20',
  },

  cameraScanOutline: {
    position: 'absolute',
    top: '17%',
    right: '17%',
    bottom: '17%',
    left: '17%',
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 22,
  },

  cameraPreview: {
    flex: 1,
    width: '100%',
    height: '100%',
  },

  cameraMessageOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(13,9,23,0.78)',
  },

  cameraErrorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: 'rgba(13,9,23,0.94)',
  },

  cameraMessageText: {
    color: COLORS.text,
    fontSize: 13,
    textAlign: 'center',
  },

  cameraRetryButton: {
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 18,
    backgroundColor: COLORS.primary,
  },

  cameraRetryText: {
    color: COLORS.background,
    fontSize: 12,
    fontWeight: '800',
  },

  cameraHint: {
    color: COLORS.muted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 18,
  },

  myQrModal: {
    width: '100%',
    maxHeight: '100%',
    alignItems: 'center',
    padding: 20,
    backgroundColor: COLORS.surface,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  qrCodePaper: {
    width: 252,
    height: 252,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
  },

  qrOwnerName: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 17,
  },

  profileSetupModal: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    padding: 22,
    backgroundColor: '#14131A',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 26,
  },

  profileSetupIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    marginBottom: 14,
  },

  profileSetupTitle: {
    color: COLORS.text,
    fontSize: 19,
    fontWeight: '800',
    textAlign: 'center',
  },

  profileSetupDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 8,
  },

  profileSetupInput: {
    width: '100%',
    minHeight: 46,
    color: COLORS.text,
    fontSize: 13,
    paddingHorizontal: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    marginTop: 18,
  },

  profileSetupActions: {
    width: '100%',
    flexDirection: 'row',
    gap: 9,
    marginTop: 12,
  },

  profileSetupGeneratedButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
  },

  profileSetupGeneratedText: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },

  profileSetupSaveButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    borderRadius: 16,
  },

  profileSetupSaveButtonDisabled: {
    opacity: 0.45,
  },

  profileSetupSaveText: {
    color: COLORS.background,
    fontSize: 12,
    fontWeight: '800',
  },

  profileSetupId: {
    color: COLORS.muted,
    fontSize: 9,
    textAlign: 'center',
    marginTop: 14,
  },

  editProfileButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 17,
    paddingVertical: 11,
    backgroundColor: '#282331',
    borderWidth: 1,
    borderColor: '#4A3C68',
    borderRadius: 12,
    marginTop: 18,
  },



  editProfileButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  profileStats: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 27,
  },

  profileStatCard: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    paddingVertical: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 17,
  },

  profileStatValue: {
    color: COLORS.text,
    fontSize: 21,
    fontWeight: '800',
    marginTop: 11,
  },

  profileStatLabel: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 4,
  },

  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },

  settingContent: {
    flex: 1,
  },

  settingTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  settingDescription: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 4,
  },

  blockedDevicesList: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
  },

  blockedDeviceRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  unblockButton: {
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
  },

  unblockButtonText: {
    color: COLORS.primary,
    fontSize: 11,
    fontWeight: '700',
  },

  blockedDevicesNote: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 15,
    paddingBottom: 12,
  },

  chatScreen: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  chatScreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 13,
    backgroundColor: 'rgba(17,25,33,0.96)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(226,238,255,0.08)',
  },

  chatScreenHeaderInfo: {
    flex: 1,
    minWidth: 0,
  },

  chatScreenName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },

  chatScreenStatus: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 4,
  },

  chatScreenBody: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
  },

  chatEncryptionBadge: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: 'rgba(130,167,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(130,167,255,0.24)',
  },

  chatEncryptionText: {
    color: COLORS.blue,
    fontSize: 11,
    fontWeight: '700',
  },

  chatNotReadyNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 13,
    borderRadius: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  chatNotReadyText: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 18,
  },

  chatComposer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: COLORS.background,
    borderTopWidth: 1,
    borderTopColor: 'rgba(226,238,255,0.1)',
  },

  chatToolButton: {
    width: 44,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },

  chatToolButtonRecording: {
    backgroundColor: '#2D1F2B',
    borderWidth: 1,
    borderColor: '#58374A',
  },

  chatComposerInput: {
    flex: 1,
    minHeight: 47,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 13,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 22,
  },

  chatComposerText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 14,
    paddingVertical: 10,
  },

  chatSendButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  messagesList: {
    flex: 1,
    marginTop: 16,
  },
  messagesContent: {
    flexGrow: 1,
    paddingBottom: 12,
  },
  messageRow: {
    width: '100%',
    marginBottom: 10,
    flexDirection: 'row',
  },
  messageRowMine: {
    justifyContent: 'flex-end',
  },
  messageRowTheirs: {
    justifyContent: 'flex-start',
  },
  messageBubbleColumn: {
    maxWidth: '84%',
  },
  messageBubbleColumnMine: {
    alignItems: 'flex-end',
  },
  messageBubbleColumnTheirs: {
    alignItems: 'flex-start',
  },
  messageBubble: {
    maxWidth: '100%',
    borderRadius: 21,
    paddingHorizontal: 13,
    paddingTop: 10,
    paddingBottom: 7,
    borderWidth: 1,
  },
  messageBubbleMine: {
    backgroundColor: '#25352D',
    borderColor: '#40583A',
    borderBottomRightRadius: 5,
  },
  messageBubbleTheirs: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderBottomLeftRadius: 5,
  },
  messageText: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 20,
  },
  messageImage: {
    width: 220,
    maxWidth: '100%',
    aspectRatio: 1.2,
    borderRadius: 8,
  },
  sharedFilePreview: {
    minWidth: 170,
    maxWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  sharedFileInfo: {
    flex: 1,
    minWidth: 0,
  },
  sharedFileName: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },
  sharedFileType: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 4,
  },
  voiceMessageButton: {
    minWidth: 170,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  voiceMessageLabel: {
    flex: 1,
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },
  messageMeta: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 7,
    marginTop: 5,
  },
  messageTime: {
    color: '#B4A9C8',
    fontSize: 9,
  },
  messageStatus: {
    color: COLORS.green,
    fontSize: 9,
  },
  messageStatusPartial: {
    color: '#FFC36B',
  },
  messageActions: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  messageActionButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSendButtonDisabled: {
    opacity: 0.45,
  },

  bottomNavigation: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    height: 72,
    marginHorizontal: 15,
    marginTop: 4,
    marginBottom: 8,
    paddingTop: 5,
    paddingBottom: 6,
    paddingHorizontal: 8,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.17)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 23,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 9 },
    shadowOpacity: 0.3,
    shadowRadius: 18,
    elevation: 12,
  },

  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: 58,
  },

  navIconWrapper: {
    width: 48,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    position: 'relative',
  },

  navIconWrapperActive: {
    backgroundColor: 'rgba(184,243,107,0.12)',
  },

  navBadge: {
    position: 'absolute',
    top: 3,
    right: 7,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.green,
    borderWidth: 1,
    borderColor: COLORS.background,
  },

  navLabel: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '600',
  },

  navLabelActive: {
    color: COLORS.primary,
    fontWeight: '800',
  },

  noticeContainer: {
    position: 'absolute',
    left: 15,
    right: 15,
    bottom: 83,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: 'rgba(16,27,37,0.98)',
    borderWidth: 1,
    borderColor: '#40384E',
    borderRadius: 21,
    elevation: 8,
  },

  noticeText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },
});
