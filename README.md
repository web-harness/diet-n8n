# diet-n8n

n8n recompiled for tight environments!

## synopsis

This is a recompilation (rebundling) of n8n, a popular workflow automation tool, using webpack. The goal is to create a version of n8n that is optimized for tight environments, such as serverless platforms or edge computing environments.

At the time of writing, the official n8n npm package comes down with a whopping 1.5GB of dependencies, which is far too large for many deployment targets. This project aims to reduce that size significantly by bundling n8n and its dynamic dependencies into smaller ESM modules.

This results in 15x reduction in size, and therefore makes it possible to deploy n8n on platforms that have strict size limits, such as AWS Lambda or Cloudflare Workers.

A side effect of this process is that it also makes n8n faster to start up, since all the dependencies are bundled together and there are fewer files to read from disk.
