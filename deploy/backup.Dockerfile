# pg_dump plus rclone, for the nightly backup (deploy/backup.sh).
FROM postgres:17-alpine
RUN apk add --no-cache rclone tzdata
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["/usr/local/bin/backup.sh", "--loop"]
