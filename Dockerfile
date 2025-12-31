FROM node:18-bookworm

# Install build dependencies for native modules and Mesa for WebGL
RUN apt-get update && apt-get install -y \
    python3 \
    python-is-python3 \
    git \
    make \
    g++ \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libxi-dev \
    libglu1-mesa-dev \
    libglew-dev \
    pkg-config \
    mesa-utils \
    libgl1-mesa-dri \
    libgl1-mesa-glx \
    libegl1-mesa \
    libgbm1 \
    xvfb \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# Set up headless GL environment
ENV LIBGL_ALWAYS_INDIRECT=1
ENV GALLIUM_DRIVER=llvmpipe

WORKDIR /app

# Install Bun
RUN npm install -g bun

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install

# Copy the rest of the application
COPY . .

CMD ["bun", "run", "main.js"]
