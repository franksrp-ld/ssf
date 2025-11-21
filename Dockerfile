# Dockerfile
FROM node:22-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Environment
ENV PORT=8080
EXPOSE 8080

# Start the server
CMD ["npm", "start"]