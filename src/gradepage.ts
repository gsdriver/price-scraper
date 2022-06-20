import chromium from "chrome-aws-lambda";
import * as logger from "./logger";
import { CoinPrice, CoinSeries } from "./utils";

let puppeteer: any;
try {
  /* tslint:disable-next-line */
  puppeteer = require("puppeteer");
} catch (e) {
  puppeteer = null;
}

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

const readNumericRow = async (page: any, row: number, price: boolean): Promise<number[]> => {
  const values: number[] = [];

  try {
    let col: number = 2;
    let valueStr: string;
    let value: number;

    do {
      valueStr = await page.evaluate(async (sel: any) => {
        return document.querySelector(sel)?.innerText;
      }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td:nth-child(${col})`);
      if (valueStr) {
        // Parse out the numeric grade and add to our list
        // Even if it is NaN (i.e. a -- line), we need to save it so we have a complete table entry
        col++;
        if (price) {
          // Convert it into cents
          value = parseFloat(valueStr.replace(/[^0-9\.]+/g, ""));
          if (!isNaN(value)) {
            value = Math.round(100 * value);
          }
        } else {
          // Not a price - just pull the raw number base 10
          value = parseInt(valueStr.replace(/[^0-9]+/g, ""), 10);
        }

        values.push(value);
      }
    } while (valueStr);
  } catch(e) {
    logger.error((e as any)?.message, "Error reading grade header");
  }

  return values;
};

const readRow = async (page: any, row: number): Promise<{ success: boolean, grades?: number[], variety?: string, year?: string, prices?: number[] }> => {
  let rowElement;
  const result: { success: boolean, grades?: number[], variety?: string, year?: string, prices?: number[] } = { success: false };

  try {
    // First determine if the row exists - if not, then we will return false immediately
    rowElement = await page.evaluate(async (sel: any) => {
      return document.querySelector(sel);
    }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row})`);
    if (!rowElement) {
      return result;
    }

    // Now, determine what type of row this is - grade headers, variety, or price list
    rowElement = await page.evaluate(async (sel: any) => {
      return document.querySelector(sel)?.innerHTML;
    }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td:nth-child(1) > table`);
    if (rowElement) {
      // OK, if this has a table within it, then it is the grade headers
      result.success = true;
      result.grades = await readNumericRow(page, row, false);
    } else {
      // If it has multiple TD elements, then this is a grading row
      rowElement = await page.evaluate(async (sel: any) => {
        return document.querySelector(sel)?.innerHTML;
      }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td:nth-child(2)`);
      if (rowElement) {
        result.success = true;

        // Read in the year in the first column
        result.year = await page.evaluate(async (sel: any) => {
          return document.querySelector(sel)?.innerText;
        }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td:nth-child(${1}) > font > b > a > font`);

        // Read in the prices
        result.prices = await readNumericRow(page, row, true);
      } else {
        rowElement = await page.evaluate(async (sel: any) => {
          return document.querySelector(sel)?.innerHTML;
        }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td > font > b`);
        if (rowElement) {
          // If it is just a single TD, then it is a variety
          result.success = true;
          result.variety = await page.evaluate(async (sel: any) => {
            return document.querySelector(sel)?.innerText;
          }, `body > center > div > table > tbody > tr:nth-child(1) > td:nth-child(1) > table > tbody > tr > td:nth-child(2) > center > table:nth-child(3) > tbody > tr:nth-child(2) > td > table:nth-child(1) > tbody > tr:nth-child(${row}) > td`);
        } else {
          logger.info("Can't determine row type", { rowElement });
        }
      }
    }
  } catch(e) {
    logger.error((e as any)?.message, `Error in row ${row}`);
  }

  return result;
};

export const readPrices = async (name: string, url: string): Promise<CoinSeries> => {
  const coinSeries: CoinSeries = { name, issues: [] };
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

    await page.goto(url, {
      waitUntil: "load",
      timeout: 0
    });

    // OK, read each row starting with the first
    let grades: number[] = [];
    let row: number = 1;
    let variety: string | undefined;
    let result: { success: boolean, grades?: number[], variety?: string, year?: string, prices?: number[] };
    do {
      result = await readRow(page, row);
      row++;

      if (result?.grades) {
        // Save these grades
        grades = result.grades;
      } else if (result?.variety) {
        // Save this variety
        variety = result.variety;
      } else if (result?.prices) {
        // Convert to an array of prices
        const prices: CoinPrice[] = [];
        result.prices.forEach((p: any, idx: number) => {
          // If this is NaN, then don't include this price
          if (!isNaN(p)) {
            prices.push({
              grade: grades[idx],
              price: p,
            });
          }
        });

        // And add into our series
        coinSeries.issues.push({
          name: result.year || "",
          variety,
          prices,
        });
      }
    } while (result?.success);

    await page.close();
  } catch(e) {
    logger.error((e as any)?.message, `Error reading ${coinSeries.name}`);
  }

  logger.info("Finished reading prices", { name });

  await browser.close();
  return coinSeries;
};
