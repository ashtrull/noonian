FROM node:carbon

# prerequisites
RUN apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv EA312927 \
  && echo "deb http://repo.mongodb.org/apt/debian wheezy/mongodb-org/3.2 main" | tee /etc/apt/sources.list.d/mongodb-org-3.2.list \
  && apt-get update \
  && apt-get install -y mongodb-org --no-install-recommends \
  && apt-get install -y uuid-runtime supervisor build-essential\
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /usr/lib/noonian
RUN npm install -g bower

# noonian stuff
COPY . .
RUN npm install
RUN bower install --allow-root
RUN cat server/conf/instance/template.js | sed s/\#instance\#/$1/g | sed s/\#instanceID\#/`uuidgen`/g | sed s/\#instanceSECRET\#/`uuidgen`/g > server/conf/instance/my_instance.js
EXPOSE 9000
RUN mkdir -p /var/log/supervisor
COPY supervisord.conf /etc/supervisord.conf
CMD /usr/bin/supervisord -c /etc/supervisord.conf
