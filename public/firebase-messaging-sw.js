importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyB9ubJNp8o_3Bvgx42DNF0SqODIwxtIMYw",
  authDomain: "forecast-app-52a7b.firebaseapp.com",
  projectId: "forecast-app-52a7b",
  storageBucket: "forecast-app-52a7b.firebasestorage.app",
  messagingSenderId: "141232431293",
  appId: "1:141232431293:web:33cc7cfa757ecc7a1b57d4"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
  });
});
