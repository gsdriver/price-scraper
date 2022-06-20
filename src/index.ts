/* tslint:disable-next-line */
const config = require("dotenv").config();
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createObjectCsvStringifier as createCsvStringifier } from "csv-writer";

import * as logger from "./logger";
import { readPrices } from "./gradepage";
import { generateSeries, getSeries } from "./series";
import { CoinIssue, CoinPrice, CoinSeries, timeout } from "./utils";

const zeroPad = (d: number) => {
  return (`0${d}`).slice(-2);
};

const buildGrades = (s: CoinSeries): number[] => {
  // Pull out each unique grade to allow us to put together a header
  const grades: number[] = [];
  s.issues.forEach((i: CoinIssue) => {
    i.prices.forEach((p: CoinPrice) => {
      if (grades.indexOf(p.grade) === -1) {
        grades.push(p.grade);
      }
    });
  });

  return grades.sort((a, b) => a - b);
};

const saveCSVFiles = async (coinSeries: CoinSeries[]): Promise<boolean> => {
  let success: boolean = false;

  // Generate the key based on the first day of the week
  const d: Date = new Date();
  d.setDate(d.getDate() - d.getDay());
  const keyPrefix: string = `${d.getFullYear()}-${zeroPad(d.getMonth() + 1)}-${zeroPad(d.getDate())}`;

  try {
    let idx: number;
    for (idx = 0; idx < coinSeries.length; idx++) {
      const s = coinSeries[idx];
      const records: string[][] = [];

      // Pull out each unique grade to allow us to put together a header
      const grades: number[] = buildGrades(s);

      // Now go through the entire structure and put together our price rows
      const headers = [ "Year", "Variety" ].concat(grades.map((g: number) => g.toString()));
      records.push(headers);
      s.issues.forEach((issue: CoinIssue) => {
        const row = [ issue.name, issue.variety || "" ];
        grades.forEach((grade: number) => {
          const price = issue.prices.find((p: CoinPrice) => p.grade === grade);
          row.push(price?.price?.toString() || "");
        });
        records.push(row);
      });

      // Generate a CSV file
      const csvStringifier = createCsvStringifier({
        header: records[0].map((h: string) => ({ id: h, title: h })),
      });

      let i: number;
      const entries: {[s: string]: string}[] = [];
      for (i = 1; i < records.length; i++) {
        const entry: {[s: string]: string} = {};

        records[i].forEach((item, j) => {
          entry[records[0][j]] = item;
        });
        entries.push(entry);
      }

      const fileText: string = csvStringifier.getHeaderString() + csvStringifier.stringifyRecords(entries);

      // Now save to S3
      const client: S3Client = new S3Client({
        region: "us-west-2",
      });

      const command = new PutObjectCommand({
        Body: fileText,
        Bucket: process.env.S3_BUCKET,
        Key: `${keyPrefix}/${s.name}.csv`,
      });
      await client.send(command);
    }

    // All done!
    success = true;
  }
  catch (e) {
    logger.error((e as any)?.message, "Problem saving to s3");
  }

  return success;
};

exports.handler = async (event: any, context: any) => {
  const seriesInfo: CoinSeries[] = [];
  logger.info("received event", { event });

  // If we just need to populate, do that
  if (event?.populate) {
    await generateSeries();
    return;
  }

  // OK, see which series we need to run in this iteration
  const coinSeries: { series: string, url: string }[] = await getSeries(event);
  logger.info("Reading series", { coinSeries });

  // Now, let's go ahead and read in each series
  let idx: number;
  for (idx = 0; idx < coinSeries.length; idx++) {
    const result: CoinSeries = await readPrices(coinSeries[idx].series, coinSeries[idx].url);
    if (result.issues.length) {
      seriesInfo.push(result);
    }

    // Wait a few seconds before going to the next series
    await timeout(event?.timeout || 2000);
  }

  // And save this to S3
  logger.info("Read series data", { seriesInfo });
  await saveCSVFiles(seriesInfo);

  return seriesInfo;
};
