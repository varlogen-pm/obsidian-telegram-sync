import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, TelegramSyncSettings, TelegramSyncSettingTab } from "./settings/Settings";
import TelegramBot from "node-telegram-bot-api";
import { machineIdSync } from "node-machine-id";
import {
	_15sec,
	_2min,
	displayAndLog,
	StatusMessages,
	displayAndLogError,
	hideMTProtoAlerts,
	_1sec,
	_5sec,
	_day,
} from "./utils/logUtils";
import * as Client from "./telegram/user/client";
import * as Bot from "./telegram/bot/bot";
import * as User from "./telegram/user/user";
import { enqueue } from "./utils/queues";
import { clearTooManyRequestsInterval } from "./telegram/bot/tooManyRequests";
import { clearCachedMessagesInterval } from "./telegram/convertors/botMessageToClientMessage";
import { clearHandleMediaGroupInterval } from "./telegram/bot/message/handlers";
import ConnectionStatusIndicator, { checkConnectionMessage } from "./ConnectionStatusIndicator";
import { mainDeviceIdSettingName } from "./settings/modals/BotSettings";
import {
	createDefaultMessageDistributionRule,
	createDefaultMessageFilterCondition,
	defaultFileNameTemplate,
	defaultMessageFilterQuery,
	defaultNoteNameTemplate,
	defaultTelegramFolder,
} from "./settings/messageDistribution";
import os from "os";
import { clearCachedUnprocessedMessages, forwardUnprocessedMessages } from "./telegram/user/sync";
import { decrypt, encrypt } from "./utils/crypto256";
import { PinCodeModal } from "./settings/modals/PinCode";
// Попробуем получить доступ к Electron API через глобальный объект
declare global {
	interface Window {
		require?: (module: string) => any;
	}
}

// TODO LOW: add "connecting"
export type ConnectionStatus = "connected" | "disconnected";
export type PluginStatus = "unloading" | "unloaded" | "loading" | "loaded";

// Main class for the Telegram Sync plugin
export default class TelegramSyncPlugin extends Plugin {
	settings: TelegramSyncSettings;
	settingsTab?: TelegramSyncSettingTab;
	private botStatus: ConnectionStatus = "disconnected";
	// TODO LOW: change to userStatus and display in status bar
	userConnected = false;
	checkingBotConnection = false;
	checkingUserConnection = false;
	// TODO LOW: TelegramSyncBot extends TelegramBot
	bot?: TelegramBot;
	botUser?: TelegramBot.User;
	createdFilePaths: string[] = [];
	currentDeviceId = machineIdSync(true);
	lastPollingErrors: string[] = [];
	restartingIntervalId?: NodeJS.Timer;
	restartingIntervalTime = _15sec;
	messagesLeftCnt = 0;
	connectionStatusIndicator? = new ConnectionStatusIndicator(this);
	status: PluginStatus = "loading";
	time4processOldMessages = false;
	processOldMessagesIntervalId?: NodeJS.Timer;
	pinCode?: string = undefined;
	private systemSleepTime?: number;
	private powerMonitorInitialized = false;
	private powerMonitor?: any;

	async initTelegram(initType?: Client.SessionType) {
		this.lastPollingErrors = [];
		this.messagesLeftCnt = 0;
		if (this.settings.mainDeviceId && this.settings.mainDeviceId !== this.currentDeviceId) {
			this.stopTelegram();
			displayAndLog(
				this,
				`Paused on this device. If you want the plugin to work here, change the value of "${mainDeviceIdSettingName}" to the current device id in the bot settings.`,
				0,
			);
			return;
		}
		// Uncomment timeout to debug if test during plugin loading
		// await new Promise((resolve) => setTimeout(resolve, 3000));

		if (!initType || initType == "user")
			await User.connect(this, this.settings.telegramSessionType, this.settings.telegramSessionId);

		if (!initType || initType == "bot") await Bot.connect(this);

		// restart telegram bot or user if needed
		if (!this.restartingIntervalId) this.setRestartTelegramInterval(this.restartingIntervalTime);

		// start processing old messages
		if (!this.processOldMessagesIntervalId) {
			this.setProcessOldMessagesInterval();
			this.time4processOldMessages = true;
			await this.processOldMessages();
		}
	}

	initPowerMonitor() {
		if (this.powerMonitorInitialized || os.type() !== "Darwin") return;
		
		try {
			// Пытаемся получить доступ к Electron API
			let powerMonitor: any = null;
			
			// Способ 1: через require (если доступен)
			if (typeof window !== 'undefined' && window.require) {
				try {
					const electron = window.require('electron');
					powerMonitor = electron.remote?.powerMonitor || electron.powerMonitor;
				} catch (e) {
					// Игнорируем ошибку и пробуем другой способ
				}
			}
			
			// Способ 2: через глобальный объект (если Obsidian предоставляет доступ)
			if (!powerMonitor && typeof (global as any) !== 'undefined') {
				try {
					const electron = (global as any).require?.('electron');
					powerMonitor = electron?.remote?.powerMonitor || electron?.powerMonitor;
				} catch (e) {
					// Игнорируем ошибку
				}
			}
			
			if (!powerMonitor) {
				displayAndLog(this, "PowerMonitor API not available, using alternative sleep detection", 0);
				this.initAlternativeSleepDetection();
				return;
			}

			// Сохраняем ссылку на powerMonitor для последующей очистки
			this.powerMonitor = powerMonitor;

			// Обработка события засыпания системы
			this.powerMonitor.on("suspend", () => {
				displayAndLog(this, "System is going to sleep, marking connections as disconnected", 0);
				this.systemSleepTime = Date.now();
				// Не отключаем соединения полностью, а только помечаем их как отключенные
				this.setBotStatus("disconnected");
				this.userConnected = false;
			});

			// Обработка события пробуждения системы
			this.powerMonitor.on("resume", () => {
				displayAndLog(this, "System resumed from sleep, reconnecting Telegram", 0);
				const sleepDuration = this.systemSleepTime ? Date.now() - this.systemSleepTime : 0;
				this.systemSleepTime = undefined;
				
				// Принудительно переподключаемся после любого сна
				setTimeout(() => {
					displayAndLog(this, `Initiating reconnection after ${Math.round(sleepDuration/1000)}s sleep`, 0);
					// Сначала останавливаем старые соединения
					this.stopTelegram();
					// Затем инициализируем заново
					setTimeout(() => {
						enqueue(this, this.initTelegram);
					}, 1000);
				}, 2000); // Даем системе 2 секунды на стабилизацию
			});

			this.powerMonitorInitialized = true;
			displayAndLog(this, "Power monitor initialized for macOS", 0);
		} catch (error) {
			displayAndLog(this, `Failed to initialize power monitor: ${error}`, 0);
			this.initAlternativeSleepDetection();
		}
	}

	initAlternativeSleepDetection() {
		// Альтернативный метод обнаружения сна через отслеживание времени
		let lastActivityTime = Date.now();
		const checkInterval = 30000; // Проверяем каждые 30 секунд
		const sleepThreshold = 120000; // Считаем, что система спала, если прошло более 2 минут
		
		const checkForSleep = () => {
			const currentTime = Date.now();
			const timeDiff = currentTime - lastActivityTime;
			
			if (timeDiff > sleepThreshold) {
				displayAndLog(this, `Detected potential system sleep (${Math.round(timeDiff/1000)}s gap), reconnecting Telegram`, 0);
				// Принудительно переподключаемся
				this.stopTelegram();
				setTimeout(() => {
					enqueue(this, this.initTelegram);
				}, 2000);
			}
			
			lastActivityTime = currentTime;
		};
		
		setInterval(checkForSleep, checkInterval);
		displayAndLog(this, "Alternative sleep detection initialized", 0);
	}

	setRestartTelegramInterval(newRestartingIntervalTime: number, sessionType?: Client.SessionType) {
		this.restartingIntervalTime = newRestartingIntervalTime;
		clearInterval(this.restartingIntervalId);
		this.restartingIntervalId = setInterval(
			async () => await enqueue(this, this.restartTelegram, sessionType),
			this.restartingIntervalTime,
		);
	}

	setProcessOldMessagesInterval() {
		this.clearProcessOldMessagesInterval();
		this.processOldMessagesIntervalId = setInterval(async () => {
			this.time4processOldMessages = true;
			await enqueue(this, this.processOldMessages);
		}, _day);
	}

	clearProcessOldMessagesInterval() {
		clearInterval(this.processOldMessagesIntervalId);
		this.processOldMessagesIntervalId = undefined;
		this.time4processOldMessages = false;
	}

	async restartTelegram(sessionType?: Client.SessionType) {
		let needRestartInterval = false;
		try {
			if (
				(!sessionType || sessionType == "user") &&
				!this.userConnected &&
				!this.checkingUserConnection &&
				this.settings.telegramSessionType == "user"
			) {
				await this.initTelegram("user");
				needRestartInterval = true;
			}

			if (
				(!sessionType || sessionType == "bot") &&
				!this.isBotConnected() &&
				!this.checkingBotConnection &&
				this.settings?.botToken
			) {
				await this.initTelegram("bot");
				needRestartInterval = true;
			}

			if (needRestartInterval) this.setRestartTelegramInterval(_15sec);
			else if (this.bot && !sessionType && os.type() == "Darwin" && this.isBotConnected()) {
				try {
					this.botUser = await this.bot.getMe();
				} catch (error) {
					displayAndLog(this, `Bot connection check failed: ${error}`, 0);
					this.setBotStatus("disconnected");
					this.userConnected = false;
					// Принудительно переподключаемся при ошибке проверки соединения
					needRestartInterval = true;
				}
			}
			
			// Дополнительная проверка для пользовательского соединения на macOS
			if (!sessionType && os.type() == "Darwin" && this.settings.telegramSessionType == "user") {
				try {
					const reconnected = await Client.reconnect(false);
					if (!reconnected && this.userConnected) {
						displayAndLog(this, "User connection lost, attempting to reconnect", 0);
						this.userConnected = false;
						needRestartInterval = true;
					}
				} catch (error) {
					displayAndLog(this, `User connection check failed: ${error}`, 0);
					this.userConnected = false;
					needRestartInterval = true;
				}
			}
			
			if (needRestartInterval) this.setRestartTelegramInterval(_15sec);
		} catch (error) {
			displayAndLog(this, `Restart telegram failed: ${error}`, 0);
			this.setRestartTelegramInterval(
				this.restartingIntervalTime < _2min ? this.restartingIntervalTime * 2 : this.restartingIntervalTime,
			);
		}
	}

	async processOldMessages() {
		if (!this.time4processOldMessages) return;
		if (!this.settings.processOldMessages) clearCachedUnprocessedMessages();
		if (!this.userConnected || !this.settings.processOldMessages || !this.botUser) return;
		try {
			await forwardUnprocessedMessages(this);
		} finally {
			this.time4processOldMessages = false;
		}
	}

	stopTelegram() {
		this.checkingBotConnection = false;
		this.checkingUserConnection = false;
		this.clearProcessOldMessagesInterval();
		clearInterval(this.restartingIntervalId);
		this.restartingIntervalId = undefined;
		Bot.disconnect(this);
		User.disconnect(this);
	}

	// Load the plugin, settings, and initialize the bot
	async onload() {
		this.status = "loading";

		await this.loadSettings();
		await this.upgradeSettings();

		// Add a settings tab for this plugin
		this.settingsTab = new TelegramSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		hideMTProtoAlerts(this);
		
		// Initialize power monitor for macOS sleep/wake handling
		this.initPowerMonitor();
		
		// Initialize the Telegram bot when Obsidian layout is fully loaded
		this.app.workspace.onLayoutReady(async () => {
			enqueue(this, this.initTelegram);
		});

		this.status = "loaded";
		displayAndLog(this, this.status, 0);
	}

	async onunload(): Promise<void> {
		this.status = "unloading";
		try {
			clearTooManyRequestsInterval();
			clearCachedMessagesInterval();
			clearHandleMediaGroupInterval();
			this.connectionStatusIndicator?.destroy();
			this.connectionStatusIndicator = undefined;
			this.settingsTab = undefined;
			this.stopTelegram();
			
			// Очищаем обработчики событий питания
			if (this.powerMonitorInitialized && this.powerMonitor && os.type() === "Darwin") {
				try {
					this.powerMonitor.removeAllListeners("suspend");
					this.powerMonitor.removeAllListeners("resume");
					this.powerMonitor = undefined;
					this.powerMonitorInitialized = false;
				} catch (error) {
					displayAndLog(this, `Failed to cleanup power monitor: ${error}`, 0);
				}
			}
		} catch (e) {
			displayAndLog(this, e, 0);
		} finally {
			this.status = "unloaded";
			displayAndLog(this, this.status, 0);
		}
	}

	// Load settings from the plugin's data
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	// Save settings to the plugin's data
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async upgradeSettings() {
		let needToSaveSettings = false;
		if (this.settings.cacheCleanupAtStartup) {
			localStorage.removeItem("GramJs:apiCache");
			this.settings.cacheCleanupAtStartup = false;
			needToSaveSettings = true;
		}

		if (this.settings.messageDistributionRules.length == 0) {
			this.settings.messageDistributionRules.push(createDefaultMessageDistributionRule());
			needToSaveSettings = true;
		} else {
			// fixing incorrectly saved rules
			this.settings.messageDistributionRules.forEach((rule) => {
				if (!rule.messageFilterQuery || !rule.messageFilterConditions) {
					rule.messageFilterQuery = defaultMessageFilterQuery;
					rule.messageFilterConditions = [createDefaultMessageFilterCondition()];
					needToSaveSettings = true;
				}
				if (!rule.filePathTemplate && !rule.notePathTemplate && !rule.templateFilePath) {
					rule.notePathTemplate = `${defaultTelegramFolder}/${defaultNoteNameTemplate}`;
					rule.filePathTemplate = `${defaultTelegramFolder}/${defaultFileNameTemplate}`;
					needToSaveSettings = true;
				}
			});
		}

		if (!this.settings.botTokenEncrypted) {
			this.botTokenEncrypt();
			needToSaveSettings = true;
		}

		needToSaveSettings && (await this.saveSettings());
	}

	async getBotUser(): Promise<TelegramBot.User> {
		this.botUser = this.botUser || (await this.bot?.getMe());
		if (!this.botUser) throw new Error("Can't get access to bot info. Restart the Telegram Sync plugin");
		return this.botUser;
	}

	isBotConnected(): boolean {
		return this.botStatus === "connected";
	}

	async setBotStatus(status: ConnectionStatus, error?: Error) {
		if (this.botStatus == status && !error) return;

		this.botStatus = status;
		this.connectionStatusIndicator?.update(error);

		if (this.isBotConnected()) displayAndLog(this, StatusMessages.BOT_CONNECTED, 0);
		else if (!error) displayAndLog(this, StatusMessages.BOT_DISCONNECTED, 0);
		else displayAndLogError(this, error, StatusMessages.BOT_DISCONNECTED, checkConnectionMessage, undefined, 0);
	}

	async getBotToken(): Promise<string> {
		if (!this.settings.botTokenEncrypted) return this.settings.botToken;

		if (this.settings.encryptionByPinCode && !this.pinCode) {
			await new Promise((resolve) => {
				const pinCodeModal = new PinCodeModal(this, true);
				pinCodeModal.onClose = async () => {
					if (!this.pinCode) displayAndLog(this, "Plugin Telegram Sync stopped. No pin code entered.");
					resolve(undefined);
				};
				pinCodeModal.open();
			});
		}
		return decrypt(this.settings.botToken, this.pinCode);
	}

	botTokenEncrypt(saveSettings = false) {
		this.settings.botToken = encrypt(this.settings.botToken, this.pinCode);
		this.settings.botTokenEncrypted = true;
		saveSettings && this.saveSettings();
		displayAndLog(this, "Bot token encrypted", 0);
	}
}
