const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/migrations'),
    clean: true,
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      externalDependencies: [
        '@nestjs/common',
        '@nestjs/config',
        'csv-parse',
        'pg',
        'reflect-metadata',
        'rxjs',
        'zod',
      ],
      generatePackageJson: true,
      sourceMap: false,
    }),
  ],
};
