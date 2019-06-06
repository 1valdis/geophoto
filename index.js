require('dotenv').config()
const express = require('express')
const { MongoClient, GridFSBucket, ObjectID } = require('mongodb')
const multer = require('multer')
const fileType = require('file-type')
const exif = require('jpeg-exif')

const mongo = new MongoClient(process.env.MONGODB_CONNECTION_STRING, { useNewUrlParser: true })
const app = express()

;(async () => {
  await mongo.connect()
  const db = mongo.db('geophoto')
  const bucket = new GridFSBucket(db, {
    bucketName: 'photos'
  })

  app.get('/', async (req, res) => {
    // photos.files must have text index on metadata.name and metadata.description
    // and 2dsphere index on metadata.coordinates
    if (req.query.text) {
      const results = await bucket
        .find({
          $text: {
            $search: req.query.text,
            $caseSensitive: false
          }
        })
        .toArray()
      res.send(results)
    } else if (req.query.coordinates) {
      const results = await bucket
        .find({
          'metadata.coordinates': {
            $nearSphere: [+req.query.coordinates.longitude, +req.query.coordinates.latitude]
          }
        })
        .toArray()
      res.send(results)
    }
  })

  app.get('/:id', (req, res) => {
    try {
      const id = new ObjectID(req.params.id)
      const downloadStream = bucket.openDownloadStream(id)
      downloadStream.pipe(res)
    } catch (e) {
      res.status(400).end(e.message)
    }
  })

  app.post('/',
    multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 500000
      }
    }).single('photo'),

    (req, res) => {
      if (!req.file) return res.status(400).end('No file')

      const type = fileType(req.file.buffer)
      if (!(type && (type.mime.includes('jpeg') || type.mime.includes('tiff')))) {
        return res.status(400).end('File is not JPEG')
      }

      const exifData = exif.fromBuffer(req.file.buffer)
      if (!(
        exifData.GPSInfo &&
        exifData.GPSInfo.GPSLatitudeRef &&
        'GPSLatitude' in exifData.GPSInfo &&
        exifData.GPSInfo.GPSLongitudeRef &&
        'GPSLongitude' in exifData.GPSInfo
      )) res.status(400).end('File has no geolocation tag')

      const { GPSLatitude, GPSLatitudeRef, GPSLongitude, GPSLongitudeRef } = exifData.GPSInfo

      const stream = bucket.openUploadStream(req.file.originalname || 'photo', {
        disableMD5: true,
        metadata: {
          contentType: type.mime,
          coordinates: {
            longitude: (GPSLongitude[0] + (GPSLongitude[1] / 60) + (GPSLongitude[2] / 3600)) * (GPSLongitudeRef === 'E' ? 1 : -1),
            latitude: (GPSLatitude[0] + (GPSLatitude[1] / 60) + (GPSLatitude[2] / 3600)) * (GPSLatitudeRef === 'N' ? 1 : -1)
          },
          name: req.body.name,
          description: req.body.description
        }
      })

      stream.end(req.file.buffer, () => {
        console.log('Upload successful')
        // const downloadStream = bucket.openDownloadStream(stream.id)
        // downloadStream.pipe(res)
        // res.on('finish', () => console.log('sent'))
        res.status(201).end()
      })
    })

  app.listen(3000, () => console.log('listening'))
})()
