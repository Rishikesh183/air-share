"use client";

import { FirebaseApp, getApp, getApps, initializeApp } from "firebase/app";
import { Auth, getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { Database, getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.databaseURL &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

export function getFirebaseApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Firebase is not configured. Copy .env.example to .env.local and fill in the NEXT_PUBLIC_FIREBASE_* values."
    );
  }
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getDb(): Database {
  return getDatabase(getFirebaseApp());
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

let signInPromise: Promise<string> | null = null;

/** Signs in anonymously (once per page load) and resolves with the uid. */
export function ensureSignedIn(): Promise<string> {
  if (signInPromise) return signInPromise;

  signInPromise = new Promise<string>((resolve, reject) => {
    let auth: Auth;
    try {
      auth = getFirebaseAuth();
    } catch (err) {
      reject(err);
      return;
    }

    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsub();
          resolve(user.uid);
        }
      },
      (err) => {
        unsub();
        reject(err);
      }
    );

    if (!auth.currentUser) {
      signInAnonymously(auth).catch((err) => {
        unsub();
        reject(err);
      });
    }
  });

  signInPromise.catch(() => {
    // allow a later retry after a transient failure
    signInPromise = null;
  });

  return signInPromise;
}
