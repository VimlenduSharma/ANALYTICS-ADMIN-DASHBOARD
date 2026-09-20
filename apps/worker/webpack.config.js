const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/worker'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      externalDependencies: [
        '@nestjs/common',
        '@nestjs/config',
        '@nestjs/core',
        'csv-parse',
        'pg',
        'reflect-metadata',
        'rxjs',
        'zod',
      ],
      generatePackageJson: true,
      sourceMap: process.env.NODE_ENV !== 'production',
    }),
  ],
};
