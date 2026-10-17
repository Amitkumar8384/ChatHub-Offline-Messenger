import React, { useEffect, useState, useRef } from 'react';

import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
} from 'react-native';

import { SafeAreaView } from 'react-native-safe-area-context';

import { nearby } from './src/nearby';
import { requestNearbyPermissions } from './src/nearbyPermissions';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const COLORS = {
  background: '#070B14',
  surface: '#101827',
  card: '#121D2F',
  border: '#24334D',
  primary: '#6D8DFF',
  text: '#F4F7FF',
  muted: '#91A0BA',
  green: '#36D6A0',
  purple: '#B29AFF',
};



function Avatar({ initials, color, size = 52, online = false }) {
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 3,
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
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
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

function EmptyState({ icon, title, description }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={30} color={COLORS.primary} />
      </View>

      <Text style={styles.emptyTitle}>{title}</Text>

      <Text style={styles.emptyDescription}>{description}</Text>
    </View>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('Home');
  const [searchQuery, setSearchQuery] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const scanningRef = useRef(false);
  const [nearbyDevices, setNearbyDevices] = useState([]);
  const [connectedDevices, setConnectedDevices] = useState([]);
  const [chats, setChats] = useState([]);
  const chatsLoadedRef = useRef(false);
  const [messageDraft, setMessageDraft] = useState('');
  const [requests, setRequests] = useState([]);
  const [notice, setNotice] = useState('');
  const [selectedChat, setSelectedChat] = useState(null);
  const selectedChatRef = useRef(null);
  const [profileName, setProfileName] = useState('Amit');
  const [isEditingProfile, setIsEditingProfile] = useState(false);

  function saveOrUpdateChat(device, updateFn) {
    if (!device?.endpointId) return;
    const id = device.endpointId;
    setChats(previous => {
      const existing = previous.find(chat => chat.endpointId === id);
      if (existing) {
        return previous.map(chat => chat.endpointId === id
          ? updateFn({ ...existing })
          : chat
        ).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      }
      const name = device.name || device.endpointName || 'Nearby device';
      const initial = {
        id,
        endpointId: id,
        name,
        initials: getInitials(name),
        color: device.color || '#386B64',
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

  function getDeviceName(endpointId, fallback = 'Nearby device') {
    return connectedDevices.find(item => item.endpointId === endpointId)?.name
      || nearbyDevices.find(item => item.endpointId === endpointId)?.name
      || requests.find(item => item.endpointId === endpointId)?.name
      || chats.find(item => item.endpointId === endpointId)?.name
      || fallback;
  }

  useEffect(() => {
    let subscriptions = [];
    let mounted = true;

    AsyncStorage.getItem('@chathub/chats')
      .then(raw => {
        if (!mounted || !raw) return;
        try {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved)) setChats(saved);
        } catch (error) {
          console.warn('Could not restore chat history:', error);
        }
      })
      .catch(error => console.warn('Could not load chat history:', error))
      .finally(() => {
        chatsLoadedRef.current = true;
      });

    const initializeNearby = async () => {
      try {
        subscriptions.push(
          nearby.addListener('deviceFound', device => {
            const name = device.endpointName || device.name || 'Nearby device';
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
            const name = request.endpointName || request.name || 'Nearby device';
            if (request.isOutgoing) {
              // Nearby Connections requires both endpoints to accept the initiated connection.
              nearby.acceptConnection(request.endpointId).catch(error => {
                console.warn('Could not accept outgoing connection handshake:', error);
                setNotice(`Could not complete connection to ${name}`);
              });
              return;
            }
            setRequests(previous => {
              if (previous.some(item => item.endpointId === request.endpointId)) return previous;
              return [...previous, {
                id: request.endpointId,
                endpointId: request.endpointId,
                name,
                initials: getInitials(name),
                detail: 'Wants to connect with you',
                color: '#7558A6',
              }];
            });
          })
        );

        subscriptions.push(
          nearby.addListener('connectionChanged', event => {
            const status = String(event.status || '').toLowerCase();
            const name = event.endpointName || event.name || getDeviceName(event.endpointId, 'Connected device');
            if (status === 'connected') {
              const device = {
                endpointId: event.endpointId,
                name,
                initials: getInitials(name),
                color: '#386B64',
              };
              setConnectedDevices(previous => previous.some(item => item.endpointId === event.endpointId)
                ? previous.map(item => item.endpointId === event.endpointId ? { ...item, ...device } : item)
                : [...previous, device]);
              setRequests(previous => previous.filter(item => item.endpointId !== event.endpointId));
              saveOrUpdateChat(device, chat => ({ ...chat, name, initials: getInitials(name), online: true, updatedAt: Date.now() }));
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
          nearby.addListener('messageReceived', event => {
            const rawMessage = event.message;
            if (typeof rawMessage !== 'string') return;
            let payload;
            try {
              payload = JSON.parse(rawMessage);
            } catch {
              payload = { text: rawMessage, id: `${Date.now()}-${Math.random()}`, sentAt: Date.now() };
            }
            const text = typeof payload.text === 'string' ? payload.text : rawMessage;
            const endpointId = event.endpointId;
            const name = event.endpointName || getDeviceName(endpointId, 'Nearby device');
            const message = {
              id: payload.id || `${Date.now()}-${Math.random()}`,
              text,
              sentAt: Number(payload.sentAt) || Date.now(),
              sender: 'them',
              senderName: payload.senderName || name,
              status: 'received',
            };
            saveOrUpdateChat({ endpointId, name }, chat => {
              const messages = [...(chat.messages || []), message];
              return {
                ...chat,
                name,
                initials: getInitials(name),
                messages,
                message: text,
                time: new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                unread: selectedChatRef.current?.endpointId === endpointId ? 0 : (chat.unread || 0) + 1,
                updatedAt: message.sentAt,
              };
            });
            setNotice(`New message from ${name}`);
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
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

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

  scanningRef.current = true;
  setIsScanning(true);
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

    try {
      await nearby.startAdvertising(profileName || 'ChatHub');
    } catch (advertisingError) {
      console.warn('Advertising start error:', advertisingError);

      // Discovery may still be running, but this phone will not be discoverable.
      setNotice('Search started, but other phones may not discover this device.');

    }

    setNotice('Searching for nearby devices...');
  } catch (error) {
    console.warn('Start scanning error:', error);

    scanningRef.current = false;
    setIsScanning(false);

    setNotice(
      'Could not start nearby search. Stop scanning and try again.'
    );
  }
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
      if (!device?.endpointId) {
        setNotice('Device ID is missing');
        return;
      }

      const deviceName = device.name || device.endpointName || 'Nearby device';
      await nearby.requestConnection(device.endpointId, deviceName);
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
    const latest = chats.find(item => item.endpointId === chat.endpointId) || chat;
    setSelectedChat(latest);
    setChats(previous => previous.map(item =>
      item.endpointId === chat.endpointId ? { ...item, unread: 0 } : item
    ));
    setMessageDraft('');
  }

  function closeChat() {
    setSelectedChat(null);
    setMessageDraft('');
  }

  async function sendChatMessage() {
    const text = messageDraft.trim();
    if (!text || !selectedChat?.endpointId) return;
    const connected = connectedDevices.some(device => device.endpointId === selectedChat.endpointId);
    if (!connected) {
      setNotice('Connect to this device before sending messages.');
      return;
    }

    const sentAt = Date.now();
    const message = {
      id: `${sentAt}-${Math.random().toString(36).slice(2, 9)}`,
      text,
      sentAt,
      sender: 'me',
      senderName: profileName || 'ChatHub User',
      status: 'sending',
    };
    setMessageDraft('');
    setChats(previous => previous.map(chat => chat.endpointId === selectedChat.endpointId
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

    try {
      await nearby.sendMessage(selectedChat.endpointId, JSON.stringify({
        id: message.id,
        text,
        sentAt,
        senderName: profileName || 'ChatHub User',
      }));
      setChats(previous => previous.map(chat => chat.endpointId === selectedChat.endpointId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'sent' } : item) }
        : chat
      ));
    } catch (error) {
      console.warn('Message send failed:', error);
      setChats(previous => previous.map(chat => chat.endpointId === selectedChat.endpointId
        ? { ...chat, messages: (chat.messages || []).map(item => item.id === message.id ? { ...item, status: 'failed' } : item) }
        : chat
      ));
      setNotice('Message could not be sent. Check the connection and retry.');
    }
  }

  function renderHeader() {
    return (
      <View style={styles.header}>
        <View style={styles.brandContainer}>
          <View style={styles.brandIcon}>
            <Ionicons
              name="chatbubbles"
              size={24}
              color={COLORS.text}
            />
          </View>

          <View>
            <Text style={styles.brandTitle}>ChatHub</Text>
            <Text style={styles.brandSubtitle}>PRIVATE · OFFLINE</Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <View style={styles.privacyBadge}>
            <Ionicons
              name="shield-checkmark"
              size={13}
              color={COLORS.green}
            />
            <Text style={styles.privacyBadgeText}>Private</Text>
          </View>

          <IconButton
            name="person-circle-outline"
            size={26}
            onPress={() => setActiveTab('Profile')}
          />
        </View>
      </View>
    );
  }

  function renderGreeting() {
    return (
      <View style={styles.greetingContainer}>
        <Text style={styles.greetingEyebrow}>YOUR PRIVATE SPACE</Text>

        <Text style={styles.greetingTitle}>
          Hey, {profileName || 'there'} 👋
        </Text>

        <Text style={styles.greetingDescription}>
          Connect nearby. Chat privately. Share freely.
        </Text>
      </View>
    );
  }

  function renderScannerCard() {
    return (
      <View style={styles.scannerCard}>
        <View style={styles.scannerCardTop}>
          <View style={styles.scannerTextContainer}>
            <View style={styles.scannerLabelRow}>
              <View style={styles.liveDot} />
              <Text style={styles.scannerEyebrow}>
                OFFLINE CONNECTION
              </Text>
            </View>

            <Text style={styles.scannerTitle}>
              People nearby
            </Text>

            <Text style={styles.scannerDescription}>
              Discover devices around you without the internet.
            </Text>
          </View>

          <View style={styles.scannerVisual}>
            <View style={styles.scannerCircleOuter}>
              <View style={styles.scannerCircleMiddle}>
                <View style={styles.scannerCircleInner}>
                  <Ionicons
                    name="radio"
                    size={28}
                    color={COLORS.text}
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
              {isScanning
                ? 'Scanning for devices...'
                : 'Ready to discover'}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.scanButton,
              isScanning && styles.scanButtonActive,
            ]}
            onPress={isScanning ? stopScanning : startScanning}
            activeOpacity={0.8}
          >
            <Ionicons
              name={isScanning ? 'stop' : 'scan'}
              size={17}
              color={COLORS.text}
            />

            <Text style={styles.scanButtonText}>
              {isScanning ? 'Stop scan' : 'Find people'}
            </Text>
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
        color: COLORS.primary,
      },
      {
        label: 'Connected',
        value: String(connectedDevices.length),
        icon: 'link-outline',
        color: COLORS.green,
      },
      {
        label: 'Requests',
        value: String(requests.length),
        icon: 'people-outline',
        color: COLORS.purple,
      },
    ];

    return (
      <View style={styles.statsContainer}>
        {stats.map(stat => (
          <View key={stat.label} style={styles.statCard}>
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
    function renderHome() {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        {renderGreeting()}
        {renderScannerCard()}
        {renderStats()}

        <SectionTitle
          title="Connected devices"
          action="View all"
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
                <Text style={styles.deviceSubtitle}>
                  Secure connection established
                </Text>
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
              initials={chat.initials}
              color={chat.color}
              online={chat.online}
            />

            <View style={styles.chatInfo}>
              <View style={styles.chatNameRow}>
                <Text style={styles.chatName}>{chat.name}</Text>
                <Text style={styles.chatTime}>{chat.time}</Text>
              </View>

              <Text style={styles.chatPreview} numberOfLines={1}>
                {chat.message}
              </Text>
            </View>

            {chat.unread > 0 ? (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {chat.unread}
                </Text>
              </View>
            ) : (
              <Ionicons
                name="chevron-forward"
                size={17}
                color={COLORS.muted}
              />
            )}
          </TouchableOpacity>
        ))}

        <View style={styles.securityBanner}>
          <View style={styles.securityBannerIcon}>
            <Ionicons
              name="shield-checkmark"
              size={22}
              color={COLORS.green}
            />
          </View>

          <View style={styles.securityBannerContent}>
            <Text style={styles.securityBannerTitle}>
              Your privacy comes first
            </Text>
            <Text style={styles.securityBannerDescription}>
              ChatHub is designed for direct, nearby connections.
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  function renderSearchBar() {
    return (
      <View style={styles.searchBar}>
        <Ionicons
          name="search-outline"
          size={20}
          color={COLORS.muted}
        />

        <TextInput
          style={styles.searchInput}
          placeholder="Search nearby devices..."
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
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <Text style={styles.pageEyebrow}>DISCOVER</Text>
          <Text style={styles.pageTitle}>Nearby people</Text>
          <Text style={styles.pageDescription}>
            Find and connect with devices around you.
          </Text>
        </View>

        {renderSearchBar()}

        <View style={styles.discoveryStatusCard}>
          <View style={styles.discoveryStatusLeft}>
            <View
              style={[
                styles.discoveryStatusIcon,
                isScanning && styles.discoveryStatusIconActive,
              ]}
            >
              <Ionicons
                name="radio-outline"
                size={25}
                color={isScanning ? COLORS.green : COLORS.primary}
              />
            </View>

            <View style={styles.discoveryStatusText}>
              <Text style={styles.discoveryStatusTitle}>
                {isScanning ? 'Searching for devices' : 'Discovery is paused'}
              </Text>

              <Text style={styles.discoveryStatusSubtitle}>
                {isScanning
                  ? 'Keep this screen open while searching.'
                  : 'Start scanning to discover nearby phones.'}
              </Text>
            </View>
          </View>

          <View
            style={[
              styles.statusPill,
              isScanning && styles.statusPillActive,
            ]}
          >
            <View
              style={[
                styles.statusPillDot,
                isScanning && styles.statusPillDotActive,
              ]}
            />

            <Text
              style={[
                styles.statusPillText,
                isScanning && styles.statusPillTextActive,
              ]}
            >
              {isScanning ? 'ACTIVE' : 'IDLE'}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={isScanning ? stopScanning : startScanning}
          activeOpacity={0.8}
        >
          <Ionicons
            name={isScanning ? 'stop-circle-outline' : 'scan-outline'}
            size={20}
            color={COLORS.text}
          />

          <Text style={styles.primaryButtonText}>
            {isScanning ? 'Stop discovery' : 'Scan for nearby devices'}
          </Text>
        </TouchableOpacity>

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
                  color="#304B77"
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
                  <TouchableOpacity
                    style={styles.connectButton}
                    onPress={() => connectToDevice(device)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.connectButtonText}>Connect</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        ) : (
          <EmptyState
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
                : 'Both phones should have ChatHub open, with nearby discovery enabled.'
            }
          />
        )}

        <View style={styles.infoCard}>
          <Ionicons
            name="information-circle-outline"
            size={21}
            color={COLORS.primary}
          />

          <Text style={styles.infoCardText}>
            For discovery to work, nearby devices must have ChatHub running
            and the required permissions enabled.
          </Text>
        </View>
      </ScrollView>
    );
  }

  function renderChats() {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <Text style={styles.pageEyebrow}>YOUR MESSAGES</Text>
          <Text style={styles.pageTitle}>Chats</Text>
          <Text style={styles.pageDescription}>
            Your conversations in one place.
          </Text>
        </View>

        {renderSearchBar()}

        <View style={styles.chatSummaryCard}>
          <View style={styles.chatSummaryIcon}>
            <Ionicons
              name="chatbubbles-outline"
              size={24}
              color={COLORS.primary}
            />
          </View>

          <View style={styles.chatSummaryContent}>
            <Text style={styles.chatSummaryTitle}>
              Your conversations
            </Text>

            <Text style={styles.chatSummaryDescription}>
              {chats.length} conversation{chats.length === 1 ? '' : 's'}
            </Text>
          </View>
        </View>

        {chats.filter(chat =>
          (chat.name || 'Nearby device').toLowerCase().includes(searchQuery.toLowerCase())
        ).length > 0 ? (
          chats
            .filter(chat =>
              (chat.name || 'Nearby device').toLowerCase().includes(searchQuery.toLowerCase())
            )
            .map(chat => (
              <TouchableOpacity
                key={chat.id}
                style={styles.chatRow}
                onPress={() => openChat(chat)}
                activeOpacity={0.75}
              >
                <Avatar
                  initials={chat.initials}
                  color={chat.color}
                  online={chat.online}
                />

                <View style={styles.chatInfo}>
                  <View style={styles.chatNameRow}>
                    <Text style={styles.chatName}>{chat.name}</Text>
                    <Text style={styles.chatTime}>{chat.time}</Text>
                  </View>

                  <Text style={styles.chatPreview} numberOfLines={1}>
                    {chat.message}
                  </Text>
                </View>

                {chat.unread > 0 && (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>
                      {chat.unread}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            ))
        ) : (
          <EmptyState
            icon="chatbubbles-outline"
            title="No conversations found"
            description="Connect with a nearby device to get started."
          />
        )}

        <View style={styles.infoCard}>
          <Ionicons
            name="information-circle-outline"
            size={21}
            color={COLORS.primary}
          />

          <Text style={styles.infoCardText}>
            Chat history is saved on this phone. Messages are sent directly to connected nearby ChatHub devices.
          </Text>
        </View>
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
          <Text style={styles.pageEyebrow}>CONNECTIONS</Text>
          <Text style={styles.pageTitle}>Requests</Text>
          <Text style={styles.pageDescription}>
            Manage people who want to connect with you.
          </Text>
        </View>

        <View style={styles.requestSummaryCard}>
          <View style={styles.requestSummaryIcon}>
            <Ionicons
              name="people-outline"
              size={24}
              color={COLORS.purple}
            />
          </View>

          <View style={styles.requestSummaryContent}>
            <Text style={styles.requestSummaryTitle}>
              Connection requests
            </Text>

            <Text style={styles.requestSummaryDescription}>
              {requests.length} pending request
              {requests.length === 1 ? '' : 's'}
            </Text>
          </View>

          <View style={styles.requestCountBadge}>
            <Text style={styles.requestCountText}>
              {requests.length}
            </Text>
          </View>
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

              <View style={styles.requestActions}>
                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => acceptRequest(request)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="checkmark"
                    size={18}
                    color="#071711"
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
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.screenContent}
      >
        <View style={styles.pageHeading}>
          <Text style={styles.pageEyebrow}>YOUR ACCOUNT</Text>
          <Text style={styles.pageTitle}>Profile</Text>
          <Text style={styles.pageDescription}>
            Customize your ChatHub experience.
          </Text>
        </View>

        <View style={styles.profileCard}>
          <View style={styles.profileAvatarWrapper}>
            <View style={styles.profileAvatar}>
              <Text style={styles.profileAvatarText}>
                {getInitials(profileName || 'A')}
              </Text>
            </View>

            <View style={styles.profileVerifiedBadge}>
              <Ionicons
                name="checkmark"
                size={14}
                color="#071711"
              />
            </View>
          </View>

          {isEditingProfile ? (
            <TextInput
              style={styles.profileNameInput}
              value={profileName}
              onChangeText={setProfileName}
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

          <Text style={styles.profileSubtitle}>
            ChatHub member
          </Text>

          <TouchableOpacity
            style={styles.editProfileButton}
            onPress={() => {
              if (isEditingProfile) {
                setProfileName(profileName.trim() || 'Amit');
                setIsEditingProfile(false);
                setNotice('Profile name updated for this session');
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

        <SectionTitle title="Privacy & settings" />

        <View style={styles.settingsCard}>
          <View style={styles.settingRow}>
            <View style={styles.settingIcon}>
              <Ionicons
                name="shield-checkmark-outline"
                size={21}
                color={COLORS.green}
              />
            </View>

            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>
                Private connections
              </Text>

              <Text style={styles.settingDescription}>
                Discover and connect with nearby devices.
              </Text>
            </View>

            <Ionicons
              name="chevron-forward"
              size={18}
              color={COLORS.muted}
            />
          </View>

          <View style={styles.settingDivider} />

          <View style={styles.settingRow}>
            <View style={styles.settingIcon}>
              <Ionicons
                name="bluetooth-outline"
                size={21}
                color={COLORS.primary}
              />
            </View>

            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>
                Nearby connectivity
              </Text>

              <Text style={styles.settingDescription}>
                Uses supported nearby communication methods.
              </Text>
            </View>

            <Ionicons
              name="chevron-forward"
              size={18}
              color={COLORS.muted}
            />
          </View>

          <View style={styles.settingDivider} />

          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setNotice('ChatHub settings')}
            activeOpacity={0.75}
          >
            <View style={styles.settingIcon}>
              <Ionicons
                name="information-circle-outline"
                size={21}
                color={COLORS.purple}
              />
            </View>

            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>
                About ChatHub
              </Text>

              <Text style={styles.settingDescription}>
                Offline messaging project.
              </Text>
            </View>

            <Ionicons
              name="chevron-forward"
              size={18}
              color={COLORS.muted}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.profileFooter}>
          <Ionicons
            name="chatbubbles"
            size={21}
            color={COLORS.primary}
          />

          <Text style={styles.profileFooterBrand}>
            ChatHub
          </Text>

          <Text style={styles.profileFooterVersion}>
            Private communication
          </Text>
        </View>
      </ScrollView>
    );
  }

  function renderChatScreen() {
    if (!selectedChat) return null;
    const liveChat = chats.find(chat => chat.endpointId === selectedChat.endpointId) || selectedChat;
    const connected = connectedDevices.some(device => device.endpointId === liveChat.endpointId);
    const messages = liveChat.messages || [];

    return (
      <View style={styles.chatScreen}>
        <View style={styles.chatScreenHeader}>
          <IconButton name="arrow-back" size={23} onPress={closeChat} />
          <Avatar
            initials={liveChat.initials || getInitials(liveChat.name)}
            color={liveChat.color || '#304B77'}
            size={42}
            online={connected}
          />
          <View style={styles.chatScreenHeaderInfo}>
            <Text style={styles.chatScreenName}>{liveChat.name || 'Nearby device'}</Text>
            <Text style={styles.chatScreenStatus}>{connected ? 'Connected • Offline messaging' : 'Not connected'}</Text>
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
            <Text style={styles.chatEncryptionText}>Nearby device connection</Text>
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
                  ? 'You are connected. Send your first message below.'
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
                  styles.messageBubble,
                  message.sender === 'me' ? styles.messageBubbleMine : styles.messageBubbleTheirs,
                ]}>
                  <Text style={styles.messageText}>{message.text}</Text>
                  <View style={styles.messageMeta}>
                    <Text style={styles.messageTime}>
                      {new Date(message.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    {message.sender === 'me' ? (
                      <Text style={styles.messageStatus}>
                        {message.status === 'failed' ? 'Failed' : message.status === 'sending' ? 'Sending…' : 'Sent'}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>

        <View style={styles.chatComposer}>
          <View style={styles.chatComposerInput}>
            <TextInput
              style={styles.chatComposerText}
              placeholder={connected ? 'Write a message…' : 'Connect to send messages'}
              placeholderTextColor={COLORS.muted}
              value={messageDraft}
              onChangeText={setMessageDraft}
              editable={connected}
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
      },
      {
        name: 'Nearby',
        icon: 'radio-outline',
        activeIcon: 'radio',
      },
      {
        name: 'Chats',
        icon: 'chatbubbles-outline',
        activeIcon: 'chatbubbles',
      },
      {
        name: 'Requests',
        icon: 'people-outline',
        activeIcon: 'people',
      },
      {
        name: 'Profile',
        icon: 'person-outline',
        activeIcon: 'person',
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
                  active && styles.navIconWrapperActive,
                ]}
              >
                <Ionicons
                  name={active ? tab.activeIcon : tab.icon}
                  size={21}
                  color={active ? COLORS.primary : COLORS.muted}
                />

                {tab.name === 'Requests' && requests.length > 0 && (
                  <View style={styles.navBadge} />
                )}
              </View>

              <Text
                style={[
                  styles.navLabel,
                  active && styles.navLabelActive,
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

      {!selectedChat && renderBottomNavigation()}

      {renderNotice()}
    </SafeAreaView>
  );}
  const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  header: {
    minHeight: 76,
    paddingHorizontal: 20,
    paddingVertical: 14,
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
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },

  brandTitle: {
    color: COLORS.text,
    fontSize: 21,
    fontWeight: '800',
    letterSpacing: -0.6,
  },

  brandSubtitle: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.7,
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
    backgroundColor: '#102A29',
    borderWidth: 1,
    borderColor: '#1E4943',
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
    marginBottom: 24,
  },

  greetingEyebrow: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 9,
  },

  greetingTitle: {
    color: COLORS.text,
    fontSize: 29,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  greetingDescription: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 7,
  },

  scannerCard: {
    backgroundColor: '#101D36',
    borderWidth: 1,
    borderColor: '#2A4169',
    borderRadius: 24,
    padding: 20,
    marginBottom: 20,
    overflow: 'hidden',
    elevation: 4,
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

  scannerLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 12,
  },

  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.green,
  },

  scannerEyebrow: {
    color: '#A8B9E0',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
  },

  scannerTitle: {
    color: COLORS.text,
    fontSize: 23,
    fontWeight: '800',
    letterSpacing: -0.5,
  },

  scannerDescription: {
    color: '#A1B0CC',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    maxWidth: 235,
  },

  scannerVisual: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 90,
    height: 105,
  },

  scannerCircleOuter: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    borderColor: '#405C91',
    backgroundColor: '#17294A',
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerCircleMiddle: {
    width: 67,
    height: 67,
    borderRadius: 34,
    borderWidth: 1,
    borderColor: '#5776B4',
    backgroundColor: '#203962',
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerCircleInner: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  scannerDivider: {
    height: 1,
    backgroundColor: '#2A4169',
    marginTop: 21,
    marginBottom: 17,
  },

  scannerBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },

  scannerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
  },

  scannerStatusText: {
    color: '#B5C3DF',
    fontSize: 11,
    fontWeight: '600',
  },

  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },

  scanButtonActive: {
    backgroundColor: '#244E48',
    borderWidth: 1,
    borderColor: '#357D70',
  },

  scanButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
  },

  statsContainer: {
    flexDirection: 'row',
    gap: 11,
    marginBottom: 29,
  },

  statCard: {
    flex: 1,
    minWidth: 0,
    padding: 13,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
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
    fontSize: 10,
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
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
  },

  sectionAction: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '700',
  },

  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 17,
    marginBottom: 11,
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
    fontSize: 14,
    fontWeight: '700',
  },

  deviceSubtitle: {
    color: COLORS.muted,
    fontSize: 11,
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
    fontSize: 12,
    fontWeight: '700',
  },

  compactEmptyDescription: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 5,
    lineHeight: 15,
  },

  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: 1,
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
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },

  chatTime: {
    color: COLORS.muted,
    fontSize: 10,
  },

  chatPreview: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 6,
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

  securityBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    backgroundColor: '#102320',
    borderWidth: 1,
    borderColor: '#23453E',
    borderRadius: 17,
    marginTop: 27,
  },

  securityBannerIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: '#18352F',
    alignItems: 'center',
    justifyContent: 'center',
  },

  securityBannerContent: {
    flex: 1,
    marginLeft: 12,
  },

  securityBannerTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
  },

  securityBannerDescription: {
    color: '#A4BDB5',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 5,
  },

  pageHeading: {
    marginBottom: 23,
  },

  pageEyebrow: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 9,
  },

  pageTitle: {
    color: COLORS.text,
    fontSize: 29,
    fontWeight: '800',
    letterSpacing: -0.8,
  },

  pageDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 19,
    marginTop: 7,
  },

  searchBar: {
    minHeight: 51,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 15,
    marginBottom: 21,
  },

  searchInput: {
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    fontSize: 12,
    paddingVertical: 12,
  },

  discoveryStatusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: 15,
    borderRadius: 18,
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
    backgroundColor: '#1A2743',
    alignItems: 'center',
    justifyContent: 'center',
  },

  discoveryStatusIconActive: {
    backgroundColor: '#15342F',
  },

  discoveryStatusText: {
    flex: 1,
    marginLeft: 12,
  },

  discoveryStatusTitle: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '800',
  },

  discoveryStatusSubtitle: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 5,
  },

  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#252B3A',
  },

  statusPillActive: {
    backgroundColor: '#15342F',
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

  primaryButton: {
    minHeight: 51,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: COLORS.primary,
    borderRadius: 15,
    marginBottom: 27,
  },

  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },

  nearbyDeviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 17,
    marginBottom: 11,
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
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    marginLeft: 8,
  },

  connectButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },

  connectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#15342F',
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

  emptyIcon: {
    width: 70,
    height: 70,
    borderRadius: 23,
    backgroundColor: '#18233B',
    borderWidth: 1,
    borderColor: '#2A3C60',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },

  emptyTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },

  emptyDescription: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 9,
  },

  infoCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 15,
    backgroundColor: '#111B2D',
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 20,
  },

  infoCardText: {
    flex: 1,
    color: COLORS.muted,
    fontSize: 11,
    lineHeight: 18,
  },

  chatSummaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 18,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 20,
  },

  chatSummaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#1A2743',
    alignItems: 'center',
    justifyContent: 'center',
  },

  chatSummaryContent: {
    flex: 1,
    marginLeft: 12,
  },

  chatSummaryTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '800',
  },

  chatSummaryDescription: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 5,
  },

  requestSummaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 18,
    marginBottom: 20,
  },

  requestSummaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#292342',
    alignItems: 'center',
    justifyContent: 'center',
  },

  requestSummaryContent: {
    flex: 1,
    marginLeft: 12,
  },

  requestSummaryTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '800',
  },

  requestSummaryDescription: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 5,
  },

  requestCountBadge: {
    minWidth: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: '#292342',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },

  requestCountText: {
    color: COLORS.purple,
    fontSize: 12,
    fontWeight: '800',
  },

  requestCard: {
    padding: 15,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 19,
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

  requestActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 17,
  },

  acceptButton: {
    flex: 1,
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.green,
    borderRadius: 12,
  },

  acceptButtonText: {
    color: '#071711',
    fontSize: 12,
    fontWeight: '800',
  },

  rejectButton: {
    flex: 1,
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#202B3D',
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
  },

  rejectButtonText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },

  profileCard: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 23,
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
    backgroundColor: '#304B77',
    borderWidth: 3,
    borderColor: '#415F93',
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

  profileSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 7,
  },

  editProfileButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 17,
    paddingVertical: 11,
    backgroundColor: '#202F4C',
    borderWidth: 1,
    borderColor: '#344C75',
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

  settingsCard: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 18,
    paddingHorizontal: 14,
  },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    gap: 11,
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

  settingDivider: {
    height: 1,
    backgroundColor: COLORS.border,
  },

  profileFooter: {
    alignItems: 'center',
    paddingVertical: 30,
  },

  profileFooterBrand: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 9,
  },

  profileFooterVersion: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 5,
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
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
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
    backgroundColor: '#102320',
    borderWidth: 1,
    borderColor: '#23453E',
  },

  chatEncryptionText: {
    color: COLORS.green,
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
    paddingHorizontal: 15,
    paddingVertical: 12,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
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
    borderRadius: 15,
  },

  chatComposerText: {
    flex: 1,
    color: COLORS.text,
    fontSize: 12,
    paddingVertical: 10,
  },

  chatSendButton: {
    width: 47,
    height: 47,
    borderRadius: 15,
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
  messageBubble: {
    maxWidth: '84%',
    borderRadius: 17,
    paddingHorizontal: 13,
    paddingTop: 10,
    paddingBottom: 7,
    borderWidth: 1,
  },
  messageBubbleMine: {
    backgroundColor: '#263D70',
    borderColor: '#3B5BA0',
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
  messageMeta: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 7,
    marginTop: 5,
  },
  messageTime: {
    color: '#AAB7D0',
    fontSize: 9,
  },
  messageStatus: {
    color: COLORS.green,
    fontSize: 9,
  },
  chatSendButtonDisabled: {
    opacity: 0.45,
  },

  bottomNavigation: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 5 : 10,
    paddingHorizontal: 5,
    backgroundColor: COLORS.background,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },

  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },

  navIconWrapper: {
    width: 44,
    height: 31,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    position: 'relative',
  },

  navIconWrapperActive: {
    backgroundColor: '#1A2743',
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
    fontSize: 9,
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
    backgroundColor: '#1A2740',
    borderWidth: 1,
    borderColor: '#354D76',
    borderRadius: 15,
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