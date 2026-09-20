const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/api'),
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
        '@fastify/cookie',
        '@fastify/helmet',
        '@nestjs/common',
        '@nestjs/config',
        '@nestjs/core',
        '@nestjs/platform-fastify',
        '@nestjs/swagger',
        'csv-parse',
        'fastify',
        'openid-client',
        'pg',
        'redis',
        'reflect-metadata',
        'rxjs',
        'zod',
      ],
      generatePackageJson: true,
      sourceMap: process.env.NODE_ENV !== 'production',
    }),
  ],
};
