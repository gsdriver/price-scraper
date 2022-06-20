import * as logger from "./logger";

export interface CoinPrice {
  grade: number;
  price: number;
}

export interface CoinIssue {
  name: string; // Eventually will break out year, mintmark, variety
  variety?: string;
  prices: CoinPrice[];
}

export interface CoinSeries {
  name: string;
  issues: CoinIssue[];
}

//
// PUPETEER HELPERS
//

export const autoScroll = async (page: any, iteration: number) => {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve(undefined);
        }
      }, 100);
    });
  });
};

export const timeout = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

//
// CHANGE DETECTION
//

// Determines whether a series has changed prices or not
export const compareCoins = (coin1: CoinSeries, coin2: CoinSeries): boolean => {
  // Fill this in later
  return true;
};
