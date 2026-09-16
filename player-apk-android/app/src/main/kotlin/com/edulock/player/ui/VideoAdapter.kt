package com.edulock.player.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide
import com.edulock.player.R
import com.edulock.player.api.data.VideoItem

/**
 * VideoAdapter.kt — Adapter para RecyclerView de videos
 */
class VideoAdapter(
    private val videos: List<VideoItem>,
    private val onVideoClick: (VideoItem) -> Unit
) : RecyclerView.Adapter<VideoAdapter.VideoViewHolder>() {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VideoViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_video, parent, false)
        return VideoViewHolder(view, onVideoClick)
    }

    override fun onBindViewHolder(holder: VideoViewHolder, position: Int) {
        holder.bind(videos[position])
    }

    override fun getItemCount() = videos.size

    class VideoViewHolder(
        itemView: View,
        private val onVideoClick: (VideoItem) -> Unit
    ) : RecyclerView.ViewHolder(itemView) {

        private val thumbnailView: ImageView = itemView.findViewById(R.id.video_thumbnail)
        private val titleView: TextView = itemView.findViewById(R.id.video_title)
        private val descriptionView: TextView = itemView.findViewById(R.id.video_description)
        private val durationView: TextView = itemView.findViewById(R.id.video_duration)

        fun bind(video: VideoItem) {
            titleView.text = video.title
            descriptionView.text = video.description ?: "Sin descripción"
            
            // Formatear duración
            if (video.resourceItem != null) {
                durationView.text = when (video.resourceItem.protection) { "protected" -> "Protegido"; null, "public" -> "Libre"; else -> "Actualizar app" }
            } else if (video.duration != null && video.duration > 0) {
                val minutes = video.duration / 60
                val seconds = video.duration % 60
                durationView.text = String.format("%02d:%02d", minutes, seconds)
            } else {
                durationView.text = "-- :--"
            }

            // Cargar thumbnail con Glide
            Glide.with(itemView.context).clear(thumbnailView)
            thumbnailView.setImageDrawable(null)
            if (video.resourceItem != null) {
                // Icono de documento en rojo de marca, con aire alrededor
                thumbnailView.scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
                val pad = (18 * itemView.resources.displayMetrics.density).toInt()
                thumbnailView.setPadding(pad, pad, pad, pad)
                thumbnailView.imageTintList = android.content.res.ColorStateList.valueOf(itemView.context.getColor(R.color.brand_red))
                thumbnailView.setImageResource(android.R.drawable.ic_menu_agenda)
                thumbnailView.contentDescription = "Recurso del curso"
            } else if (!video.thumbnail.isNullOrEmpty()) {
                thumbnailView.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
                thumbnailView.setPadding(0, 0, 0, 0)
                thumbnailView.imageTintList = null
                Glide.with(itemView.context)
                    .load(video.thumbnail)
                    .centerCrop()
                    .into(thumbnailView)
            }

            // Click listener
            itemView.setOnClickListener {
                onVideoClick(video)
            }
        }
    }
}
