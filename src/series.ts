import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import chromium from "chrome-aws-lambda";
import * as logger from "./logger";

let puppeteer: any;
try {
  /* tslint:disable-next-line */
  puppeteer = require("puppeteer");
} catch (e) {
  puppeteer = null;
}

const SERIESFILE = "serieslist.json";
const RUNPERIOD = 4;
const RUNSPERDAY = Math.round(24 / RUNPERIOD);
const RUNSPERWEEK = 7 * RUNSPERDAY;

const launchBrowser = async () => {
  let browser;

  if (puppeteer) {
    browser = await puppeteer.launch();
  } else {
    browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  }

  return browser;
};

const readSeriesTable = async (page: any, row: number, col: number): Promise<{ series: string, url: string}[]> => {
  const result: { series: string, url: string }[] = [];
  let idx: number = 1;

  try {
    let series: { series: string, url: string } | undefined;

    do {
      series = { series: "", url: "" };
      series.url = await page.evaluate(async (sel: any) => {
        return document.querySelector(sel)?.getAttribute("href");
      }, `body > center > table > tbody > tr > td:nth-child(2) > table > tbody > tr > td > table:nth-child(2) > tbody > tr > td > table > tbody > tr > td > table:nth-child(1) > tbody > tr > td:nth-child(2) > table > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(${row}) > td:nth-child(${col}) > table > tbody > tr > td > table > tbody > tr > td > font > font > a:nth-child(${idx})`);

      if (series.url?.length) {
        // Replace "search7" with "search6" to get a wide table on search
        series.url = series.url.replace("search7", "search6");
        series.series = await page.evaluate(async (sel: any) => {
          return document.querySelector(sel)?.innerText;
        }, `body > center > table > tbody > tr > td:nth-child(2) > table > tbody > tr > td > table:nth-child(2) > tbody > tr > td > table > tbody > tr > td > table:nth-child(1) > tbody > tr > td:nth-child(2) > table > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(${row}) > td:nth-child(${col}) > table > tbody > tr > td > table > tbody > tr > td > font > font > a:nth-child(${idx})`);

        // Need to trim the series name
        series.series = (series.series || "").split("(")[0].replace(/[^0-9a-zA-Z ]/g, "").trim();
        result.push(series);

        // There's gotta be a better way than this...
        idx += 4;
      }
    } while (series?.url?.length);
  } catch(e) {
    logger.error((e as any)?.message, `Error reading table ${row}, ${col}`);
  }

  return result;
};

const readSeries = async (): Promise<{ series: string, url: string }[]> => {
  let series: { series: string, url: string }[] = [];
  let page: any;
  const browser = await launchBrowser();

  try {
    page = await browser.newPage();

    // Don't load images, JSS, CSS
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (["image", "font", "stylesheet", "javascript"].indexOf(req.resourceType()) > -1) {
        req.abort();
      }
      else {
        req.continue();
      }
    });

    await page.goto(process.env.COINURL, {
      waitUntil: "load",
      timeout: 0
    });

    // OK, let's start reading tables
    let row: number = 3;
    let noEntries: boolean = true;

    do {
      // OK, completely read this row (should only be two columns but we'll be flexible)
      let col: number = 1;
      let entries: number = 0;

      do {
        const tableEntries = await readSeriesTable(page, row, col++);
        series = series.concat(tableEntries);
        entries = tableEntries.length;
        noEntries = (col === 2) && (entries === 0);

        if (entries > 0) {
          logger.info("Read Table", { row, col: col - 1 });
        }
      } while (entries > 0);

      // Let's move to the next row
      row++;
    } while (!noEntries);

    await page.close();
  } catch(e) {
    logger.error((e as any)?.message, "Error reading page");
  }

  await browser.close();
  return series;
};

export const readFromS3 = async (): Promise<string> => {
  let value: any;
  const region = "us-west-2";
  const client = new S3Client({ region });

  try {
    const streamToString = (stream: any) =>
      new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on("data", (chunk: any) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: SERIESFILE,
    });

    const { Body } = await client.send(command);
    value = await streamToString(Body);
  }
  catch (e) {
    logger.info("Error reading from S3", { value });
  }

  return value;
};

export const generateSeries = async () => {
  // We will read in the coin series and save it to S3
  const coinSeries: { series: string, url: string }[] = await readSeries();
  logger.info("Read series", { coinSeries });

  // Now save to S3
  const client: S3Client = new S3Client({
    region: "us-west-2",
  });

  const command = new PutObjectCommand({
    Body: JSON.stringify(coinSeries),
    Bucket: process.env.S3_BUCKET,
    Key: SERIESFILE,
  });
  await client.send(command);
};

export const getSeries = async (event: any): Promise<{ series: string, url: string }[]> => {
  // If there is a series passed in, just use that
  if (event?.series && event?.url) {
    // We'll use the value that was passed in
    return [{ series: event.series, url: event.url }];
  }

  // Let's read the list from S3 -- if not present, try to generate and read
  let seriesText: string = await readFromS3();
  if (!seriesText?.length) {
    await generateSeries();
    seriesText = await readFromS3();
  }
  const series: { series: string, url: string }[] = JSON.parse(seriesText);

  // We'll dynamically calculate how many series to return based on hours since start of week
  // We run every 4 hours (6 times per day), so take 1/42 of the list each time we run
  const d = new Date();
  const slice: number = d.getDay() * RUNSPERDAY + Math.floor(d.getHours() / RUNPERIOD);
  const iStart: number = Math.floor(slice * (series.length / RUNSPERWEEK));
  const iEnd: number = Math.floor((slice + 1) * (series.length / RUNSPERWEEK));

  return series.slice(iStart, iEnd + 1);
};
