import type { DragEvent } from 'react';
import type { FallbackAssets } from '../../../types/realtime';
import { assetDragMimeType, contentTabConfig } from '../constants';
import type { ContentTab } from '../types';
import { VideoThumbnail } from './VideoThumbnail';

type ContentBrowserProps = {
  assets: FallbackAssets;
  activeTab: ContentTab;
  selectedAssetValue: string | null;
  onTabChange: (tab: ContentTab) => void;
  onSelectAsset: (value: string | null) => void;
  onDragEnd: () => void;
};

const buildAssetValue = (type: 'video' | 'glsl' | 'generative', id?: string) => {
  if (type === 'generative') return 'generative';
  if (!id) return '';
  return `${type}:${id}`;
};

export const ContentBrowser = ({
  assets,
  activeTab,
  selectedAssetValue,
  onTabChange,
  onSelectAsset,
  onDragEnd,
}: ContentBrowserProps) => {
  const hasVideos = assets.videos.length > 0;
  const hasShaders = assets.glsl.length > 0;
  const overlayAssets = assets.overlays ?? [];

  const resolveVideoFolder = (url?: string, folder?: string) => {
    if (folder) return folder.toLowerCase();
    if (!url) return '';
    if (url.includes('/overlay/')) return 'overlay';
    if (url.includes('/footage/')) return 'footage';
    return '';
  };

  const footageVideos = assets.videos.filter(
    (video) => resolveVideoFolder(video.url, video.folder) === 'footage',
  );

  const overlayVideos =
    overlayAssets.length > 0
      ? overlayAssets.map((item) => ({
          id: item.id,
          name: item.name,
          url: item.url,
          category: '',
          folder: resolveVideoFolder(item.url, item.folder),
        }))
      : assets.videos
          .filter((video) => resolveVideoFolder(video.url, video.folder) === 'overlay')
          .map((video) => ({
            ...video,
            folder: resolveVideoFolder(video.url, video.folder),
          }));

  const handleAssetDragStart = (event: DragEvent<HTMLElement>, assetValue: string) => {
    if (!assetValue) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(assetDragMimeType, assetValue);
    event.dataTransfer.setData('text/plain', assetValue);
  };

  const handleAssetClick = (value: string) => {
    onSelectAsset(selectedAssetValue === value ? null : value);
  };

  const renderGenerativeContent = () => (
    <div className="content-browser-items">
      <div
        className={`content-browser-item generative${
          selectedAssetValue === 'generative' ? ' is-selected' : ''
        }`}
        draggable
        onDragStart={(event) => handleAssetDragStart(event, buildAssetValue('generative'))}
        onDragEnd={onDragEnd}
        onClick={() => handleAssetClick('generative')}
      >
        <span className="content-browser-item-name">Generative Shader</span>
      </div>
    </div>
  );

  const renderFootageContent = () => {
    if (!hasVideos || footageVideos.length === 0) {
      return <div className="content-browser-empty">Place footage files under ./mp4/footage</div>;
    }
    return (
      <div className="content-browser-items">
        {footageVideos.map((video) => {
          const value = buildAssetValue('video', video.id);
          return (
            <div
              key={video.id}
              className={`content-browser-item${
                selectedAssetValue === value ? ' is-selected' : ''
              }`}
              draggable
              onDragStart={(event) => handleAssetDragStart(event, value)}
              onDragEnd={onDragEnd}
              onClick={() => handleAssetClick(value)}
            >
              <div className="content-browser-item-preview">
                <VideoThumbnail
                  src={video.url}
                  alt={video.category ? `${video.category}/${video.name}` : video.name}
                  className="content-browser-item-preview-media"
                />
              </div>
              <div className="content-browser-item-info">
                <span className="content-browser-item-name">
                  {video.category ? `${video.category}/` : ''}
                  {video.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderShaderContent = () => {
    if (!hasShaders) {
      return <div className="content-browser-empty">Place .glsl files under ./glsl</div>;
    }
    return (
      <div className="content-browser-items">
        {assets.glsl.map((shader) => {
          const value = buildAssetValue('glsl', shader.id);
          return (
            <div
              key={shader.id}
              className={`content-browser-item shader${
                selectedAssetValue === value ? ' is-selected' : ''
              }`}
              draggable
              onDragStart={(event) => handleAssetDragStart(event, value)}
              onDragEnd={onDragEnd}
              onClick={() => handleAssetClick(value)}
            >
              <div className="content-browser-item-info">
                <span className="content-browser-item-name">{shader.name}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOverlayContent = () => {
    if (overlayVideos.length === 0) {
      return <div className="content-browser-empty">Place overlay files under ./mp4/overlay</div>;
    }
    return (
      <div className="content-browser-items">
        {overlayVideos.map((video) => {
          const value = buildAssetValue('video', video.id);
          return (
            <div
              key={video.id}
              className={`content-browser-item${
                selectedAssetValue === value ? ' is-selected' : ''
              }`}
              draggable
              onDragStart={(event) => handleAssetDragStart(event, value)}
              onDragEnd={onDragEnd}
              onClick={() => handleAssetClick(value)}
            >
              <div className="content-browser-item-preview">
                <VideoThumbnail
                  src={video.url}
                  alt={video.name}
                  className="content-browser-item-preview-media"
                />
              </div>
              <div className="content-browser-item-info">
                <span className="content-browser-item-name">{video.name}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  let body;
  switch (activeTab) {
    case 'glsl':
      body = renderShaderContent();
      break;
    case 'footage':
      body = renderFootageContent();
      break;
    case 'overlay':
      body = renderOverlayContent();
      break;
    case 'generative':
    default:
      body = renderGenerativeContent();
      break;
  }

  return (
    <div className="content-browser control-card">
      <div className="content-browser-tabs">
        {contentTabConfig.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`content-browser-tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="content-browser-body">{body}</div>
    </div>
  );
};
