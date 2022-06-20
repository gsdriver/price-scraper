import * as winston from "winston";
import {format, Logger, transports} from "winston";

const logger: Logger = winston.createLogger({
    defaultMeta: {service: "CoinScrape"},
    format: format.combine(
        format.timestamp({format: "YYYY-MM-DD HH:mm:ss"}),
        format.errors({stack: true}),
        format.splat(),
        format.json(),
    ),
    level: "info",
    transports: [new transports.Console()],
});

export function info(message: string, props: object) {
    logger.info({...props, ...{message}});
}

export function error(err: Error, message?: string, props?: object) {
    const p = props || {};
    logger.error({...p, ...{error: err}, ...{message}});
}

export function debug(message: string, props: object) {
    logger.debug({...props, ...{message}});
}
