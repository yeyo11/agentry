import { contextBridge } from 'electron';

// The main process hands the app version over as a renderer argument (see webPreferences.additionalArguments)
const VERSION_ARG = '--agentry-version=';
const version = process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? '';

// Lets the UI tell it runs inside the desktop shell; nothing else is exposed on purpose
contextBridge.exposeInMainWorld('agentryDesktop', { platform: process.platform, version });
