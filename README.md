# ChatHub — Offline Messenger 📱

ChatHub is an Android messaging application built with React Native and Expo. It uses Google Nearby Connections to discover nearby devices and exchange messages without relying on a traditional internet-based messaging server.

## ✨ Features

- 📡 Nearby device discovery
- 💬 Direct messaging between connected devices
- 🔗 Connection requests and device connection management
- 📱 Android application
- 🔐 Permission handling for nearby connectivity
- 🌐 Designed for offline, nearby communication

## 🛠️ Tech Stack

- React Native
- Expo
- JavaScript
- Kotlin
- Google Nearby Connections API
- Android SDK
- Gradle

## 📂 Project Structure

```text
ChatHub-Offline-Messenger/
├── android/
├── assets/
├── src/
│   ├── nearby.js
│   └── nearbyPermissions.js
├── App.js
├── app.json
├── index.js
├── package.json
├── package-lock.json
└── README.md





⚙️ Requirements
Node.js
npm
Android Studio
Android SDK
JDK 17
Android device for testing nearby communication
🚀 Getting Started
1. Clone the repository
git clone https://github.com/Amitkumar8384/ChatHub-Offline-Messenger.git
2. Open the project
cd ChatHub-Offline-Messenger
3. Install dependencies
npm install
4. Start Expo
npx expo start

For native Android development, ensure Android Studio and the Android SDK are configured correctly.

📡 How It Works

ChatHub uses Google Nearby Connections to discover nearby devices and establish direct connections for exchanging messages.

Note: The current implementation supports direct device-to-device messaging. Multi-hop mesh forwarding and store-and-forward messaging are not currently implemented.

🧪 Testing

Tested with two Android phones for nearby device discovery, connection establishment, and direct message exchange.

🗺️ Future Improvements
 Multi-hop mesh messaging
 Store-and-forward message delivery
 Message history and persistence
 Improved connection recovery
 Chat interface enhancements
 Release APK distribution
👨‍💻 Developer

Amit Kumar

GitHub: @Amitkumar8384

📄 License

See the LICENSE file for license information.
