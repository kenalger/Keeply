// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_harsh_young_avengers.sql';
import m0001 from './0001_furry_boom_boom.sql';
import m0002 from './0002_short_human_robot.sql';
import m0003 from './0003_panoramic_hedge_knight.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003
    }
  }
  