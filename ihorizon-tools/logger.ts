/*
・ iHorizon Discord Bot (https://gitlab.com/ihrz/ihrz)

・ Licensed under the Attribution-NonCommercial-ShareAlike 2.0 Generic (CC BY-NC-SA 2.0)

    ・   Under the following terms:

        ・ Attribution — You must give appropriate credit, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.

        ・ NonCommercial — You may not use the material for commercial purposes.

        ・ ShareAlike — If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.

        ・ No additional restrictions — You may not apply legal terms or technological measures that legally restrict others from doing anything the license permits.


・ Mainly developed by Kisakay (https://gitlab.com/Kisakay)

・ Copyright © 2020-2024 iHorizon
*/

import { log as _ } from 'console';
import "./colors.ts";

type LoggerMessageType = any;
interface Logger {
    log: (message: LoggerMessageType, ...optionalParams: any[]) => void;
    legacy: (message: LoggerMessageType, ...optionalParams: any[]) => void;
    warn: (message: LoggerMessageType, ...optionalParams: any[]) => void;
    err: (message: LoggerMessageType, ...optionalParams: any[]) => void;
    returnLog: (message: LoggerMessageType, ...optionalParams: any[]) => string;
}

const LogLevel = Object.freeze({
    LOG: 'LOG',
    WARN: 'WRN',
    ERROR: 'ERR',
    LEGACY: 'LEG'
});
type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

function getCurrentTime(): string {
    const now = new Date();

    const timestamp = now.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    return `${timestamp}`;
}

function formatMessage(level: LogLevelValue, message: any, ...optionalParams: any[]): string {
    const timestamp = getCurrentTime();
    const prefix = `[${timestamp} ${level}]:`;

    const coloredPrefix = applyColorToPrefix(prefix, level);

    const messageStr = typeof message === 'object' ? JSON.stringify(message, null, 2) : String(message);
    const paramsStr = optionalParams.length > 0
        ? ' ' + optionalParams.map(param =>
            typeof param === 'object' ? JSON.stringify(param, null, 2) : String(param)
        ).join(' ')
        : '';
    return coloredPrefix + ' ' + messageStr + paramsStr;
}

function applyColorToPrefix(prefix: string, level: LogLevelValue): string {
    switch (level) {
        case LogLevel.LOG:
            return prefix.green;
        case LogLevel.WARN:
            return prefix.yellow;
        case LogLevel.ERROR:
            return prefix.red;
        case LogLevel.LEGACY:
            return prefix.cyan;
        default:
            return prefix;
    }
}

const logger: Logger = {
    log(message: any, ...optionalParams: any[]): void {
        const formattedMessage = formatMessage(LogLevel.LOG, message, ...optionalParams);
        _(formattedMessage);
    },

    warn(message: any, ...optionalParams: any[]): void {
        const formattedMessage = formatMessage(LogLevel.WARN, message, ...optionalParams);
        _(formattedMessage);
    },

    err(message: any, ...optionalParams: any[]): void {
        const formattedMessage = formatMessage(LogLevel.ERROR, message, ...optionalParams);
        _(formattedMessage);

        if (typeof process !== 'undefined' && process.stderr) {
            process.stderr.write(formattedMessage + '\n');
        }
    },

    legacy(message: any, ...optionalParams: any[]): void {
        if (optionalParams.length > 0) {
            _(message, ...optionalParams);
        } else {
            _(message);
        }
    },

    returnLog(message: any, ...optionalParams: any[]): string {
        return formatMessage(LogLevel.LOG, message, ...optionalParams);
    }
};

export default logger;
